/**
 * The half of `cvx record` that produces mocks.
 *
 * Every outbound HTTP call the app makes while recording is a dependency that
 * has to be stubbed before its tests can run anywhere else. Keploy discovers
 * these by redirecting egress into a proxy from the kernel; we get there with
 * the HTTP_PROXY convention instead, which every mainstream HTTP client in
 * every language already honours and which needs no privileges at all.
 *
 * HTTPS is the honest limit. A CONNECT tunnel is opaque without a trusted
 * interception certificate, so those calls are counted and named but not
 * recorded — and `cvx record` says so in its summary rather than reporting a
 * capture that quietly missed half the traffic.
 */

import * as http from 'http';
import * as net from 'net';
import { captureAndForward } from './bodyBuffer';
import type { RecordedExchange } from './exchange';

export interface EgressProxyOptions {
  readonly listenPort: number;
  readonly onExchange: (exchange: RecordedExchange) => void;
  readonly onOpaqueConnect: (host: string) => void;
  /**
   * Set when TLS interception is available. Without it a CONNECT is tunnelled
   * blind, which is the old behaviour and still the fallback when openssl is
   * missing.
   */
  readonly interceptor?: {
    handleConnect(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void;
  };
}

function headersOf(source: http.IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || name.toLowerCase().startsWith('proxy-')) continue;
    result[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return result;
}

/** Relay one plaintext outbound call to its real destination and record it. */
function relay(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: EgressProxyOptions
): void {
  const target = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const startedAt = new Date();
  const startedHr = Date.now();
  const requestHeaders = headersOf(req.headers);

  const upstream = http.request(
    {
      host: target.hostname,
      port: target.port || 80,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: requestHeaders,
    },
    async (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers as http.OutgoingHttpHeaders);
      // `capturedRequest` is assigned below, before this callback can run: the
      // response cannot arrive until the request has been sent.
      const [requestBody, responseBody] = await Promise.all([
        capturedRequest,
        captureAndForward(upstreamRes, res),
      ]);

      options.onExchange({
        direction: 'egress',
        method: req.method || 'GET',
        url: target.toString(),
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
    // The app asked for a host that is down or does not resolve. That is the
    // app's problem to see, so relay it as a gateway error and keep recording.
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
    }
    res.end(`cvx record could not reach ${target.host}: ${error.message}\n`);
  });

  const capturedRequest = captureAndForward(req, upstream);
}

/**
 * Tunnel a CONNECT verbatim, for when interception is unavailable. The bytes
 * are TLS and stay unreadable; all we can honestly report is that the app
 * talked to this host.
 */
function tunnel(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
  options: EgressProxyOptions
): void {
  const [host, rawPort] = (req.url || '').split(':');
  const port = Number(rawPort) || 443;
  options.onOpaqueConnect(`${host}:${port}`);

  const upstream = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  const drop = () => { upstream.destroy(); clientSocket.destroy(); };
  upstream.on('error', drop);
  clientSocket.on('error', drop);
}

/**
 * Loopback only, and this one is not negotiable.
 *
 * A forward proxy relays to whatever host the client names. Bound to every
 * interface it is an open relay: anyone sharing the network can route traffic
 * through the developer's machine and reach whatever that machine can reach —
 * cloud instance metadata, internal services, anything behind the VPN. Only
 * the recorded app needs to reach this port, and it is on this machine.
 */
export const BIND_ADDRESS = '127.0.0.1';

/** Start the forward proxy. Resolves once it is accepting connections. */
export function startEgressProxy(
  options: EgressProxyOptions
): Promise<http.Server> {
  const server = http.createServer((req, res) => relay(req, res, options));
  server.on('connect', (req, socket, head) => {
    if (options.interceptor) {
      options.interceptor.handleConnect(req, socket as net.Socket, head);
      return;
    }
    tunnel(req, socket as net.Socket, head, options);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.listenPort, BIND_ADDRESS, () => resolve(server));
  });
}
