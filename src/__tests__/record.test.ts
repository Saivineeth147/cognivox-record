/**
 * Tests for `cvx record`.
 *
 * The end-to-end cases here start real servers and send real requests. A
 * recorder is exactly the kind of component that unit tests bless while it is
 * broken — every one of its failures looks like "no traffic happened" — so the
 * contract worth testing is the one an executing request exercises.
 */

import * as http from 'http';
import { toHarEntry, baseMimeType, type RecordedExchange } from '../record/exchange';
import {
  appPortFor, childEnvironment, isFailedOutcome, nodeShimPath,
} from '../record/session';
import { startIngressProxy, BIND_ADDRESS } from '../record/ingressProxy';
import { dependencyNote } from '../commands/record';
import { startEgressProxy } from '../record/egressProxy';
import { captureAndForward, type CollectedBody } from '../record/bodyBuffer';
import { Readable, Writable } from 'stream';

function exchange(overrides: Partial<RecordedExchange> = {}): RecordedExchange {
  return {
    direction: 'ingress',
    method: 'GET',
    url: 'http://localhost:3000/api/users?page=2',
    requestHeaders: { accept: 'application/json' },
    requestBody: null,
    requestBytes: 0,
    status: 200,
    statusText: 'OK',
    responseHeaders: { 'content-type': 'application/json; charset=utf-8' },
    responseBody: '{"ok":true}',
    responseBytes: 11,
    startedAt: new Date('2026-09-11T00:00:00Z'),
    durationMs: 12,
    ...overrides,
  };
}

/** Start a server that echoes what it received, so the proxy can be checked. */
function startTarget(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.stringify({ saw: req.url, sent: Buffer.concat(chunks).toString() });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(body);
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

function portOf(server: http.Server): number {
  return (server.address() as { port: number }).port;
}

describe('baseMimeType', () => {
  it('should strip charset so the importer recognises JSON bodies', () => {
    expect(baseMimeType('application/json; charset=utf-8')).toBe('application/json');
  });

  it('should return an empty string when there is no content type', () => {
    expect(baseMimeType('')).toBe('');
  });
});

describe('toHarEntry', () => {
  it('should give every header both a name and a value', () => {
    const entry = toHarEntry(exchange()) as any;
    // The importer reads header['name'], not header.get('name'); a missing key
    // raises there rather than being skipped.
    for (const header of [...entry.request.headers, ...entry.response.headers]) {
      expect(Object.keys(header).sort()).toEqual(['name', 'value']);
    }
  });

  it('should record the response mime type, which gates the API filter', () => {
    const entry = toHarEntry(exchange()) as any;
    expect(entry.response.content.mimeType).toBe('application/json');
  });

  it('should expand the query string so params import separately', () => {
    const entry = toHarEntry(exchange()) as any;
    expect(entry.request.queryString).toEqual([{ name: 'page', value: '2' }]);
  });

  it('should report the bytes transferred, not the bytes retained', () => {
    // A body past the size cap is dropped from memory but relayed in full.
    // Sizing from the retained text would record a 5 MB download as a
    // zero-byte response — "this endpoint returns nothing".
    const entry = toHarEntry(exchange({
      responseBody: null, responseBytes: 5 * 1024 * 1024,
    })) as any;
    expect(entry.response.bodySize).toBe(5 * 1024 * 1024);
    expect(entry.response.content.size).toBe(5 * 1024 * 1024);
    expect(entry.response.content.text).toBeUndefined();
  });

  it('should omit postData entirely when there is no request body', () => {
    const entry = toHarEntry(exchange()) as any;
    expect(entry.request.postData).toBeUndefined();
  });

  it('should carry a JSON request body with a bare mime type', () => {
    const entry = toHarEntry(exchange({
      method: 'POST',
      requestBody: '{"name":"Grace"}',
      requestBytes: 16,
      requestHeaders: { 'content-type': 'application/json; charset=utf-8' },
    })) as any;
    expect(entry.request.postData.mimeType).toBe('application/json');
    expect(entry.request.postData.text).toBe('{"name":"Grace"}');
  });
});

describe('childEnvironment', () => {
  const built = childEnvironment({ base: { PATH: '/bin' }, appPort: 3001, egressPort: 16789 });

  it('should move the app off the port the recorder needs', () => {
    expect(built.PORT).toBe('3001');
  });

  it('should set proxy variables in both cases, since clients differ', () => {
    expect(built.HTTP_PROXY).toBe('http://127.0.0.1:16789');
    expect(built.http_proxy).toBe('http://127.0.0.1:16789');
  });

  it('should preload the shim that makes Node egress visible', () => {
    expect(built.NODE_OPTIONS).toContain(nodeShimPath());
  });

  it('should keep NODE_OPTIONS the developer already set', () => {
    const withExisting = childEnvironment({
      base: { NODE_OPTIONS: '--inspect' }, appPort: 3001, egressPort: 16789,
    });
    expect(withExisting.NODE_OPTIONS).toContain('--inspect');
    expect(withExisting.NODE_OPTIONS).toContain('--require');
  });
});

describe('appPortFor', () => {
  it('should place the app one above the recorded port', () => {
    expect(appPortFor(3000)).toBe(3001);
  });
});

describe('isFailedOutcome', () => {
  it('should treat a Ctrl-C stop as a successful recording', () => {
    expect(isFailedOutcome({ kind: 'signalled', signal: 'SIGTERM' })).toBe(false);
  });

  it('should treat a clean exit as success', () => {
    expect(isFailedOutcome({ kind: 'exited', code: 0 })).toBe(false);
  });

  it('should treat a crashed app as a failure', () => {
    expect(isFailedOutcome({ kind: 'exited', code: 1 })).toBe(true);
  });

  it('should treat an unstartable command as a failure', () => {
    expect(isFailedOutcome({ kind: 'failed', message: 'ENOENT' })).toBe(true);
  });
});

describe('the ingress proxy, against real servers', () => {
  let target: http.Server;
  let proxy: http.Server;
  let recorded: RecordedExchange[];

  beforeEach(async () => {
    recorded = [];
    target = await startTarget();
    proxy = await startIngressProxy({
      listenPort: 0,
      targetPort: portOf(target),
      targetHost: '127.0.0.1',
      onExchange: (e) => recorded.push(e),
    });
  });

  afterEach(async () => {
    proxy.closeAllConnections();
    target.closeAllConnections();
    await new Promise((r) => proxy.close(r));
    await new Promise((r) => target.close(r));
  });

  function send(path: string, body?: string): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: portOf(proxy), path, method: body ? 'POST' : 'GET',
          headers: body ? { 'content-type': 'application/json' } : {} },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode || 0, text }));
        }
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  it('should return the app response unchanged to the caller', async () => {
    const response = await send('/api/users');
    expect(response.status).toBe(201);
    expect(JSON.parse(response.text).saw).toBe('/api/users');
  });

  it('should record the exchange it relayed', async () => {
    await send('/api/users');
    expect(recorded).toHaveLength(1);
    expect(recorded[0].method).toBe('GET');
    expect(recorded[0].status).toBe(201);
    expect(recorded[0].direction).toBe('ingress');
  });

  it('should relay a request body to the app and record it', async () => {
    await send('/api/users', '{"name":"Grace"}');
    expect(JSON.parse(recorded[0].responseBody!).sent).toBe('{"name":"Grace"}');
    expect(recorded[0].requestBody).toBe('{"name":"Grace"}');
  });

  it('should report a 502 rather than hanging when the app is not up', async () => {
    await new Promise((r) => target.close(r));
    const response = await send('/api/users');
    expect(response.status).toBe(502);
    expect(response.text).toContain('nothing is listening');
  });
});

describe('binding', () => {
  it('should keep the ingress proxy on loopback, not the whole network', async () => {
    const proxy = await startIngressProxy({
      listenPort: 0, targetPort: 1, targetHost: '127.0.0.1', onExchange: () => {},
    });
    // 0.0.0.0 would publish the app under test to every machine on the
    // developer's network, debug endpoints and seeded credentials included.
    expect((proxy.address() as { address: string }).address).toBe('127.0.0.1');
    proxy.closeAllConnections();
    await new Promise((r) => proxy.close(r));
  });

  it('should keep the egress proxy on loopback, since it relays anywhere', async () => {
    const proxy = await startEgressProxy({
      listenPort: 0, onExchange: () => {}, onOpaqueConnect: () => {},
    });
    // A forward proxy on 0.0.0.0 is an open relay: anyone on the network could
    // reach whatever this machine can reach, instance metadata included.
    expect((proxy.address() as { address: string }).address).toBe('127.0.0.1');
    proxy.closeAllConnections();
    await new Promise((r) => proxy.close(r));
  });

  it('should expose the same bind address from both proxies', () => {
    expect(BIND_ADDRESS).toBe('127.0.0.1');
  });
});

describe('captureAndForward', () => {
  /** Feed `totalBytes` through the capture, and report what it held on to. */
  async function pump(totalBytes: number, cap: number): Promise<{
    body: CollectedBody; forwarded: number; peakRetained: number;
  }> {
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let remaining = totalBytes;
    const source = new Readable({
      read() {
        if (remaining <= 0) return this.push(null);
        const size = Math.min(chunk.length, remaining);
        remaining -= size;
        this.push(chunk.subarray(0, size));
      },
    });
    let forwarded = 0;
    const sink = new Writable({
      write(c: Buffer, _e, cb) { forwarded += c.length; cb(); },
    });
    const body = await captureAndForward(source, sink, cap);
    return { body, forwarded, peakRetained: body.retainedBytes };
  }

  it('should keep a body that fits under the cap', async () => {
    const { body } = await pump(1000, 4096);
    expect(body.truncated).toBe(false);
    expect(body.text).toHaveLength(1000);
  });

  it('should stop retaining once the cap is passed', async () => {
    // The first version set a flag and pushed the chunk anyway, so the cap
    // bounded nothing and a large download was still held whole in memory.
    // Asserting on `text` did not catch that — it is null whenever truncated,
    // however many bytes were kept — so this asserts on the retained count.
    const { body, peakRetained } = await pump(5 * 1024 * 1024, 256 * 1024);
    expect(body.truncated).toBe(true);
    expect(peakRetained).toBe(0);
  });

  it('should never retain more than the cap allows', async () => {
    const cap = 256 * 1024;
    const { body } = await pump(5 * 1024 * 1024, cap);
    expect(body.retainedBytes).toBeLessThanOrEqual(cap);
  });

  it('should still forward every byte of an oversized body', async () => {
    const size = 5 * 1024 * 1024;
    const { forwarded } = await pump(size, 256 * 1024);
    expect(forwarded).toBe(size);
  });

  it('should report the true size even when it retained nothing', async () => {
    const { body } = await pump(5 * 1024 * 1024, 256 * 1024);
    expect(body.totalBytes).toBe(5 * 1024 * 1024);
  });
});

describe('dependencyNote', () => {
  it('should report the count for a TLS dependency that was decoded', () => {
    // The old note called every TLS connection string unreadable on sight,
    // so a recording that captured 2 queries over TLS was reported as a
    // failure — the exact confusion the summary exists to prevent.
    const note = dependencyNote({ encrypted: true }, 2, { tlsIntercepted: true });
    expect(note).toContain('2 interaction(s)');
    expect(note).not.toContain('not readable');
  });

  it('should explain a TLS zero only when interception was impossible', () => {
    const note = dependencyNote({ encrypted: true }, 0, { tlsIntercepted: false });
    expect(note).toContain('not readable');
  });

  it('should give a plain zero for a plaintext dependency nothing used', () => {
    expect(dependencyNote({ encrypted: false }, 0, { tlsIntercepted: true })).toBe('0 interaction(s)');
  });
});
