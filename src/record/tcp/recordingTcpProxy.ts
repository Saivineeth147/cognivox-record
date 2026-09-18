/**
 * A TCP proxy that relays a connection verbatim and hands both directions to a
 * protocol parser on the way past.
 *
 * Relaying is deliberately byte-exact and independent of parsing: if a parser
 * cannot make sense of a stream the connection must still work, because a
 * recorder that breaks the app it is recording is worse than one that records
 * nothing. Parser output is additive, never in the data path.
 */

import * as net from 'net';
import type {
  DependencyInteraction, ProtocolRecorderFactory,
} from './protocol';

/** Loopback only — the same reasoning as the HTTP recorders. */
export const BIND_ADDRESS = '127.0.0.1';

export interface TcpProxyOptions {
  readonly listenPort: number;
  readonly upstreamHost: string;
  readonly upstreamPort: number;
  readonly createRecorder: ProtocolRecorderFactory;
  readonly onInteraction: (interaction: DependencyInteraction) => void;
}

/** Wire one accepted connection to the upstream, recording as bytes pass. */
function bridge(client: net.Socket, options: TcpProxyOptions): void {
  const recorder = options.createRecorder();
  const upstream = net.connect(options.upstreamPort, options.upstreamHost);

  const flush = () => {
    for (const interaction of recorder.drain()) options.onInteraction(interaction);
  };

  client.on('data', (chunk) => {
    safely(() => recorder.onClientData(chunk));
    upstream.write(chunk);
  });
  upstream.on('data', (chunk) => {
    safely(() => recorder.onServerData(chunk));
    client.write(chunk);
    flush();
  });

  const close = () => { flush(); upstream.destroy(); client.destroy(); };
  client.on('end', close);
  upstream.on('end', close);
  client.on('error', close);
  upstream.on('error', close);
}

/**
 * A parser fault must never break the relay. Swallowing the error here is the
 * one place that is correct: the app keeps working and the recording loses one
 * interaction, rather than the developer losing their database connection.
 */
function safely(parse: () => void): void {
  try {
    parse();
  } catch {
    // Intentionally ignored — see above. The lost interaction is absent from
    // the recording, which the summary's counts will reflect.
  }
}

/** Start the proxy. Resolves once it is accepting connections. */
export function startTcpProxy(options: TcpProxyOptions): Promise<net.Server> {
  const server = net.createServer((client) => bridge(client, options));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.listenPort, BIND_ADDRESS, () => resolve(server));
  });
}
