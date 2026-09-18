/**
 * Records a Postgres connection that negotiates TLS.
 *
 * Postgres does not use CONNECT. A client opens a plain socket, sends an
 * eight-byte SSLRequest, and upgrades in place if the server answers 'S'. That
 * in-band upgrade is why this cannot reuse the HTTPS interceptor: there is no
 * tunnel to hand to an HTTP server, only a socket that changes meaning
 * mid-stream.
 *
 * Intercepting it means answering the client's SSLRequest ourselves with a
 * certificate for the database host, then performing our own upgrade against
 * the real server — two handshakes with decoded protocol in between.
 */

import * as net from 'net';
import * as tls from 'tls';
import { readStartup } from '../protocols/postgresMessages';
import { leafCertificateFor, type CertificateAuthority } from './certificateAuthority';
import type { DependencyInteraction, ProtocolRecorderFactory } from '../tcp/protocol';

export const BIND_ADDRESS = '127.0.0.1';

const SSL_ACCEPTED = Buffer.from('S', 'ascii');
const SSL_REQUEST_BYTES = 8;

export interface PostgresTlsProxyOptions {
  readonly listenPort: number;
  readonly upstreamHost: string;
  readonly upstreamPort: number;
  readonly authority: CertificateAuthority;
  readonly createRecorder: ProtocolRecorderFactory;
  readonly onInteraction: (interaction: DependencyInteraction) => void;
  /** Called when the upgrade could not be intercepted, with the reason. */
  readonly onUpgradeFailure: (reason: string) => void;
}

/** Pipe two decrypted streams, feeding a recorder as bytes pass. */
function record(
  client: NodeJS.ReadWriteStream,
  upstream: NodeJS.ReadWriteStream,
  options: PostgresTlsProxyOptions
): void {
  const recorder = options.createRecorder();
  const flush = () => {
    for (const interaction of recorder.drain()) options.onInteraction(interaction);
  };

  client.on('data', (chunk: Buffer) => {
    try { recorder.onClientData(chunk); } catch { /* relay must survive a parse fault */ }
    upstream.write(chunk);
  });
  upstream.on('data', (chunk: Buffer) => {
    try { recorder.onServerData(chunk); } catch { /* as above */ }
    client.write(chunk);
    flush();
  });
}

/**
 * Upgrade the upstream connection, then bridge the two decrypted sides.
 *
 * `rejectUnauthorized` is false here for a specific reason rather than
 * convenience. A client that verifies its database certificate would already
 * have refused *our* certificate, so by the time this code runs the app has
 * chosen not to verify — `sslmode=require`, which encrypts without checking
 * identity. Matching that posture upstream keeps the recording faithful to
 * what the app was doing; imposing stricter verification would break
 * connections that work without the recorder.
 */
function upgradeUpstream(
  clientTls: tls.TLSSocket,
  options: PostgresTlsProxyOptions
): void {
  const upstreamSocket = net.connect(options.upstreamPort, options.upstreamHost, () => {
    const request = Buffer.alloc(SSL_REQUEST_BYTES);
    request.writeInt32BE(SSL_REQUEST_BYTES, 0);
    request.writeInt32BE(80877103, 4);
    upstreamSocket.write(request);
  });

  upstreamSocket.once('data', (reply: Buffer) => {
    if (String.fromCharCode(reply[0]) !== 'S') {
      options.onUpgradeFailure('the database refused TLS');
      upstreamSocket.destroy();
      clientTls.destroy();
      return;
    }
    const upstreamTls = tls.connect({
      socket: upstreamSocket,
      servername: options.upstreamHost,
      rejectUnauthorized: false,
    }, () => record(clientTls, upstreamTls, options));

    const drop = () => { upstreamTls.destroy(); clientTls.destroy(); };
    upstreamTls.on('error', drop);
    clientTls.on('error', drop);
  });

  upstreamSocket.on('error', (error) => {
    options.onUpgradeFailure(error.message);
    clientTls.destroy();
  });
}

/** Relay without decoding, for a connection we could not read. */
function passThrough(client: net.Socket, first: Buffer, options: PostgresTlsProxyOptions): void {
  const upstream = net.connect(options.upstreamPort, options.upstreamHost, () => {
    upstream.write(first);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  const drop = () => { upstream.destroy(); client.destroy(); };
  upstream.on('error', drop);
  client.on('error', drop);
}

/** Start a proxy that can follow a Postgres TLS upgrade. */
export function startPostgresTlsProxy(
  options: PostgresTlsProxyOptions
): Promise<net.Server> {
  const server = net.createServer((client) => {
    client.once('data', (first: Buffer) => {
      const startup = readStartup(first);
      if (startup.kind !== 'ssl-request') {
        // A plaintext connection: hand it back the bytes and relay normally.
        passThrough(client, first, options);
        return;
      }

      client.write(SSL_ACCEPTED);
      let leaf;
      try {
        leaf = leafCertificateFor(options.upstreamHost, options.authority);
      } catch (error) {
        options.onUpgradeFailure((error as Error).message);
        client.destroy();
        return;
      }

      const clientTls = new tls.TLSSocket(client, {
        isServer: true, key: leaf.key, cert: leaf.cert,
      });
      clientTls.on('error', (error) => {
        // The client rejected our certificate — sslmode=verify-full, which
        // pins a CA we are not in. Named rather than silently unrecorded.
        options.onUpgradeFailure(`client refused the recording certificate: ${error.message}`);
        clientTls.destroy();
      });
      upgradeUpstream(clientTls, options);
    });
    client.on('error', () => client.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.listenPort, BIND_ADDRESS, () => resolve(server));
  });
}
