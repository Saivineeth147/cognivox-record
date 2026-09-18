/**
 * Preloaded into a recorded Node app so its outbound HTTP calls are visible.
 *
 * Go, Python, curl and axios all read the `*_PROXY` environment variables, so
 * `cvx record` sees their egress for free. Node's own `http` module is the
 * conspicuous exception: it ignores proxy environment variables entirely, and
 * an unpatched Node app therefore records a clean-looking session in which
 * every dependency call is silently missing. Nothing errors — the calls just
 * go direct — which is the worst shape a recording bug can take.
 *
 * This is loaded with `node --require` and rewrites outbound requests to go
 * through the recorder the way a forward proxy expects: connect to the proxy,
 * and put the absolute URL in the request line.
 */

// Deliberately `import =` rather than `import * as`: the latter compiles to
// `__importStar`, which hands back a *copy* of the module whose properties are
// non-configurable, and every attempt to patch it throws at load time. Only the
// object `require` returns is the one the app itself will use.
import http = require('http');
import https = require('https');
import net = require('net');
import tls = require('tls');

/** Set by the recorder; without it this shim does nothing at all. */
const PROXY_URL = process.env.COGNIVOX_EGRESS_PROXY;

type RequestArgs = Parameters<typeof http.request>;

interface ProxyTarget {
  readonly hostname: string;
  readonly port: number;
}

function parseProxy(raw: string): ProxyTarget | null {
  try {
    const parsed = new URL(raw);
    return { hostname: parsed.hostname, port: Number(parsed.port) || 80 };
  } catch {
    return null;
  }
}

/**
 * Node accepts `(url)`, `(url, options)`, `(options)` and any of those with a
 * callback. Normalising to a single options object is what lets one rewrite
 * cover every call shape an app might use.
 */
export function toOptions(args: RequestArgs): http.RequestOptions | null {
  const [first, second] = args;
  if (typeof first === 'string' || first instanceof URL) {
    const url = typeof first === 'string' ? safeUrl(first) : first;
    if (!url) return null;
    const fromUrl: http.RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      // The default depends on the scheme. Assuming 80 sends an https:// URL
      // through a tunnel to the plaintext port, where the TLS handshake fails
      // with "wrong version number" and looks like a proxy fault.
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
    };
    return typeof second === 'object' && second !== null
      ? { ...fromUrl, ...(second as http.RequestOptions) }
      : fromUrl;
  }
  return typeof first === 'object' && first !== null ? (first as http.RequestOptions) : null;
}

function safeUrl(raw: string): URL | null {
  try { return new URL(raw); } catch { return null; }
}

/**
 * A request already aimed at the recorder must be left alone, or the shim
 * proxies its own traffic to itself and the app hangs on the first call.
 */
function shouldProxy(options: http.RequestOptions, proxy: ProxyTarget): boolean {
  if (options.protocol && options.protocol !== 'http:') return false;
  const host = options.hostname || options.host;
  if (!host) return false;
  const port = Number(options.port) || 80;
  const isProxyItself =
    (host === proxy.hostname || host === 'localhost') && port === proxy.port;
  return !isProxyItself;
}

function rewritten(
  options: http.RequestOptions,
  proxy: ProxyTarget
): http.RequestOptions {
  const host = options.hostname || options.host;
  const port = Number(options.port) || 80;
  const authority = port === 80 ? String(host) : `${host}:${port}`;
  return {
    ...options,
    hostname: proxy.hostname,
    host: proxy.hostname,
    port: proxy.port,
    // A forward proxy is addressed with the absolute URL in the request line.
    path: `http://${authority}${options.path || '/'}`,
    headers: { ...(options.headers || {}), host: authority },
  };
}

/**
 * Node's overloads for `request` are too specific to describe a pass-through
 * wrapper, and its module exports are readonly. Replacing them needs a loose
 * signature and a cast; both are confined to this function.
 */
type LooseRequest = (this: unknown, ...args: unknown[]) => http.ClientRequest;

/** Swap one of http's exported functions for a recording wrapper. */
function replaceExport(name: 'request' | 'get', implementation: LooseRequest): void {
  (http as unknown as Record<string, LooseRequest>)[name] = implementation;
}

function install(proxy: ProxyTarget): void {
  const originalRequest = http.request as unknown as LooseRequest;

  const patched: LooseRequest = function (this: unknown, ...args: unknown[]) {
    const options = toOptions(args as RequestArgs);
    if (!options || !shouldProxy(options, proxy)) {
      return originalRequest.apply(this, args);
    }
    const callback = args.find((arg) => typeof arg === 'function');
    const forwarded: unknown[] = callback
      ? [rewritten(options, proxy), callback]
      : [rewritten(options, proxy)];
    return originalRequest.apply(this, forwarded);
  };

  replaceExport('request', patched);
  // `http.get` calls the module-local `request`, not the exported one, so
  // patching `request` alone leaves every `http.get` call unrecorded.
  replaceExport('get', function (this: unknown, ...args: unknown[]) {
    const req = patched.apply(this, args);
    req.end();
    return req;
  });
}

/**
 * Route Node's HTTPS calls through the recorder too.
 *
 * `http` can be proxied by rewriting the request line, but TLS cannot: the
 * client must first ask the proxy to open a tunnel with CONNECT and only then
 * negotiate TLS through it. Without this, a Node app's HTTPS egress — which is
 * most of its third-party traffic — goes direct and is never recorded, while
 * everything appears to work.
 */
function installHttps(proxy: ProxyTarget): void {
  const mutableHttps = https as unknown as Record<string, unknown>;
  const originalRequest = https.request as unknown as LooseRequest;

  const patched: LooseRequest = function (this: unknown, ...args: unknown[]) {
    const options = toOptions(args as RequestArgs);
    const host = options?.hostname || options?.host;
    if (!options || !host) return originalRequest.apply(this, args);

    const port = Number(options.port) || 443;
    // Node's agent accepts an asynchronous `createConnection`: returning
    // undefined and calling back later is the supported way to defer, which is
    // exactly what waiting for a CONNECT response requires.
    const agent = Object.assign(new https.Agent(), {
      createConnection(
        _connectOptions: unknown,
        callback: (error: Error | null, socket?: unknown) => void
      ) {
        openTunnel(proxy, String(host), port, callback);
        return undefined;
      },
    }) as unknown as https.Agent;
    const withAgent = { ...options, agent };
    const callback = args.find((arg) => typeof arg === 'function');
    return originalRequest.apply(
      this, callback ? [withAgent, callback] : [withAgent]
    );
  };

  mutableHttps.request = patched;
  mutableHttps.get = function (this: unknown, ...args: unknown[]) {
    const req = patched.apply(this, args);
    req.end();
    return req;
  };
}

/** Ask the proxy for a tunnel, then negotiate TLS through it. */
function openTunnel(
  proxy: ProxyTarget,
  host: string,
  port: number,
  callback: (error: Error | null, socket?: unknown) => void
): void {
  const socket = net.connect(proxy.port, proxy.hostname, () => {
    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
  });

  const onEstablished = (chunk: Buffer) => {
    const header = chunk.toString('utf8', 0, Math.min(chunk.length, 64));
    if (!header.startsWith('HTTP/1.1 200') && !header.startsWith('HTTP/1.0 200')) {
      callback(new Error(`proxy refused CONNECT to ${host}:${port}`));
      socket.destroy();
      return;
    }
    socket.removeListener('data', onEstablished);
    callback(null, tls.connect({ socket, servername: host }));
  };

  socket.once('data', onEstablished);
  socket.on('error', (error) => callback(error));
}

const target = PROXY_URL ? parseProxy(PROXY_URL) : null;
if (target) {
  install(target);
  installHttps(target);
}
