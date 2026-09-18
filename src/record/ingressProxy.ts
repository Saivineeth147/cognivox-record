/**
 * The half of `cvx record` that produces test cases.
 *
 * Keploy captures inbound traffic with eBPF, which buys transparency at the
 * cost of Linux 4.15+, root, and a kernel that cooperates — none of which a
 * developer on macOS has. A reverse proxy gets the same request/response pairs
 * with nothing but a socket.
 *
 * The trick that makes it invisible: the app is moved to `port + 1` via the
 * PORT environment variable that every mainstream web framework honours, and
 * the recorder listens on the port the developer was already using. Existing
 * curl commands, browser tabs and frontend configs keep working untouched.
 */

import * as http from 'http';
import { captureAndForward } from './bodyBuffer';
import type { RecordedExchange } from './exchange';

/** Hop-by-hop headers are per-connection and must not be relayed (RFC 7230 §6.1). */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

export interface IngressProxyOptions {
  readonly listenPort: number;
  readonly targetPort: number;
  readonly targetHost: string;
  readonly onExchange: (exchange: RecordedExchange) => void;
}

function forwardableHeaders(
  headers: http.IncomingHttpHeaders
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase()) || value === undefined) continue;
    result[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return result;
}

function absoluteUrl(req: http.IncomingMessage, listenPort: number): string {
  const host = req.headers.host || `localhost:${listenPort}`;
  return `http://${host}${req.url || '/'}`;
}

/**
 * Relay one request to the app and record both halves.
 *
 * Both bodies stream through rather than being buffered and re-sent, so a large
 * upload costs no memory and a streaming response reaches the caller as it is
 * produced instead of only once it completes.
 *
 * Failures to reach the app are relayed as a 502 rather than swallowed: during
 * recording the app is often still booting, and a silent hang looks to the
 * developer like the recorder is broken.
 */
function relay(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: IngressProxyOptions
): void {
  const startedAt = new Date();
  const startedHr = Date.now();
  const requestHeaders = forwardableHeaders(req.headers);

  const upstream = http.request(
    {
      host: options.targetHost,
      port: options.targetPort,
      method: req.method,
      path: req.url,
      headers: requestHeaders,
    },
    async (upstreamRes) => {
      const responseHeaders = forwardableHeaders(upstreamRes.headers);
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers as http.OutgoingHttpHeaders);
      const [requestBody, responseBody] = await Promise.all([
        capturedRequest,
        captureAndForward(upstreamRes, res),
      ]);

      options.onExchange({
        direction: 'ingress',
        method: req.method || 'GET',
        url: absoluteUrl(req, options.listenPort),
        requestHeaders,
        requestBody: requestBody.text,
        requestBytes: requestBody.totalBytes,
        status: upstreamRes.statusCode || 0,
        statusText: upstreamRes.statusMessage || '',
        responseHeaders,
        responseBody: responseBody.text,
        responseBytes: responseBody.totalBytes,
        startedAt,
        durationMs: Date.now() - startedHr,
      });
    }
  );

  upstream.on('error', (error: NodeJS.ErrnoException) => {
    const reason = error.code === 'ECONNREFUSED'
      ? `nothing is listening on ${options.targetHost}:${options.targetPort} yet`
      : error.message;
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
    }
    res.end(`cvx record could not reach your app: ${reason}\n`);
  });

  const capturedRequest = captureAndForward(req, upstream);
}

/**
 * Loopback only. Binding every interface would publish the app being recorded
 * — debug endpoints, seeded credentials and all — to every other machine on
 * whatever network the developer happens to be on.
 */
export const BIND_ADDRESS = '127.0.0.1';

/** Start the reverse proxy. Resolves once it is accepting connections. */
export function startIngressProxy(
  options: IngressProxyOptions
): Promise<http.Server> {
  const server = http.createServer((req, res) => relay(req, res, options));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.listenPort, BIND_ADDRESS, () => resolve(server));
  });
}
