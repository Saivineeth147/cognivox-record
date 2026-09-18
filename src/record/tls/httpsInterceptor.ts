/**
 * Reads HTTPS egress by terminating the app's TLS and re-originating it.
 *
 * Before this, a CONNECT was tunnelled blind: the recorder could name the host
 * an app talked to and nothing else. Since almost every third-party dependency
 * — payment, storage, auth — is HTTPS, that left the mock set covering only
 * the minority of calls that happen to be plaintext.
 *
 * Node does the hard parts. A `https.Server` handed the raw socket performs
 * the TLS handshake with a certificate minted for the requested host and then
 * parses HTTP off the decrypted stream, so there is no hand-written TLS record
 * layer or HTTP parser here to get subtly wrong.
 */

import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import { captureAndForward } from '../bodyBuffer';
import { leafCertificateFor, type CertificateAuthority } from './certificateAuthority';
import type { RecordedExchange } from '../exchange';

export interface HttpsInterceptorOptions {
  readonly authority: CertificateAuthority;
  readonly onExchange: (exchange: RecordedExchange) => void;
  /** Hosts whose TLS could not be intercepted, for honest reporting. */
  readonly onInterceptFailure: (host: string, reason: string) => void;
}

function headersOf(source: http.IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    result[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return result;
}

/**
 * Relay one decrypted request to the real server over a fresh TLS connection.
 *
 * The upstream connection validates normally against the system trust store:
 * intercepting the app's view of TLS is the point, but silently accepting an
 * invalid certificate from the real server would turn a recording session into
 * a downgrade of the developer's actual security.
 */
async function relay(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  host: string,
  port: number,
  options: HttpsInterceptorOptions
): Promise<void> {
  const startedAt = new Date();
  const startedHr = Date.now();
  const requestHeaders = headersOf(req.headers);

  const upstream = https.request(
    {
      host, port, method: req.method, path: req.url,
      headers: requestHeaders, servername: host,
    },
    async (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers as http.OutgoingHttpHeaders);
      const [requestBody, responseBody] = await Promise.all([
        capturedRequest,
        captureAndForward(upstreamRes, res),
      ]);
      options.onExchange({
        direction: 'egress',
        method: req.method || 'GET',
        url: `https://${host}${port === 443 ? '' : `:${port}`}${req.url || '/'}`,
        requestHeaders,
        requestBody: requestBody.text,
        requestBytes: requestBody.totalBytes,
        status: upstreamRes.statusCode || 0,
        statusText: upstreamRes.statusMessage || '',
        responseHeaders: headersOf(upstreamRes.headers),
        responseBody: responseBody.text,
        responseBytes: responseBody.totalBytes,
        startedAt,
        durationMs: Date.now() - startedHr,
      });
    }
  );

  upstream.on('error', (error) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`cvx record could not reach ${host}: ${error.message}\n`);
  });

  const capturedRequest = captureAndForward(req, upstream);
}

/**
 * Where a decrypted request was actually headed.
 *
 * SNI is the authoritative source — it is what selected the certificate — and
 * the Host header supplies the port. HTTP/1.1 makes Host mandatory, so the
 * fallback only matters for clients that are already misbehaving.
 */
function targetOf(req: http.IncomingMessage): { host: string; port: number } {
  const sni = (req.socket as tls.TLSSocket).servername;
  const header = String(req.headers.host || '');
  const [headerHost, headerPort] = header.split(':');
  return {
    host: sni || headerHost || 'unknown',
    port: Number(headerPort) || 443,
  };
}

/** Handles CONNECT by terminating TLS rather than tunnelling past it. */
export function createHttpsInterceptor(options: HttpsInterceptorOptions): {
  handleConnect(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void;
  close(): void;
} {
  // One server handles every host; SNI decides which certificate to present.
  const server = https.createServer({
    SNICallback: (servername, callback) => {
      try {
        const leaf = leafCertificateFor(servername, options.authority);
        callback(null, tls.createSecureContext({ key: leaf.key, cert: leaf.cert }));
      } catch (error) {
        callback(error as Error);
      }
    },
  });

  server.on('request', (req, res) => {
    const { host, port } = targetOf(req);
    relay(req, res, host, port, options).catch((error) => {
      if (res.headersSent) return;
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`cvx record failed to relay: ${String(error)}\n`);
    });
  });

  server.on('tlsClientError', (error, socket) => {
    // The app refused our certificate — a pinned client, or one carrying its
    // own trust store. Named rather than counted as zero, because "no HTTPS
    // calls" and "a call we were not allowed to read" are different facts.
    const attempted = (socket as tls.TLSSocket).servername;
    options.onInterceptFailure(attempted || 'unknown', error.message);
  });

  return {
    handleConnect(req, socket, head) {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) socket.unshift(head);
      socket.on('error', () => socket.destroy());

      // Handing the raw socket to the HTTPS server makes Node perform the
      // handshake (choosing a certificate via SNI) and then parse HTTP off the
      // decrypted stream. `host` and `port` from the CONNECT are not carried
      // across on the socket; they are recovered per request from SNI and the
      // Host header, both of which HTTP/1.1 requires a client to send.
      server.emit('connection', socket);
    },
    close() { server.close(); },
  };
}
