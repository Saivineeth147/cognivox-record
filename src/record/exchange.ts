/**
 * The wire format between `cvx record` and everything downstream.
 *
 * Recording captures request/response pairs; the server already knows how to
 * turn a HAR into a suite with assertions and a mock set. Rather than invent a
 * second format and a second importer, the recorder emits HAR 1.2 and reuses
 * that path. Every field written here is one the importer actually reads —
 * `app/routes/import_export.py` and `app/importers/har_assertions.py`.
 */

/** A single captured request/response pair. */
export interface RecordedExchange {
  /** 'ingress' becomes a test case; 'egress' becomes a mock. */
  readonly direction: 'ingress' | 'egress';
  readonly method: string;
  readonly url: string;
  readonly requestHeaders: Record<string, string>;
  readonly requestBody: string | null;
  /**
   * Bytes actually transferred, which is not the length of the retained text:
   * a body past the size cap is dropped from memory but still relayed in full.
   * Deriving the size from the text instead would record a 5 MB download as a
   * zero-byte response, which reads as "this endpoint returns nothing".
   */
  readonly requestBytes: number;
  readonly status: number;
  readonly statusText: string;
  readonly responseHeaders: Record<string, string>;
  readonly responseBody: string | null;
  readonly responseBytes: number;
  readonly startedAt: Date;
  readonly durationMs: number;
}

/** A host we tunnelled but could not read, so the summary can say so. */
export interface OpaqueConnection {
  readonly host: string;
  readonly count: number;
}

interface HarNameValue {
  name: string;
  value: string;
}

/**
 * The importer reads headers with `header['name']`, not `.get('name')`, so an
 * entry missing either key raises rather than being skipped. Always emit both.
 */
function toNameValueList(source: Record<string, string>): HarNameValue[] {
  return Object.entries(source).map(([name, value]) => ({
    name,
    value: String(value ?? ''),
  }));
}

function queryStringOf(url: string): HarNameValue[] {
  try {
    const parsed = new URL(url);
    return [...parsed.searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function headerValue(headers: Record<string, string>, name: string): string {
  const match = Object.keys(headers).find(
    (key) => key.toLowerCase() === name.toLowerCase()
  );
  return match ? headers[match] : '';
}

/**
 * The importer compares the mime type with `== 'application/json'` exactly, so
 * a perfectly ordinary `application/json; charset=utf-8` would import the body
 * as an opaque string and lose every field assertion. Strip the parameters.
 */
export function baseMimeType(contentType: string): string {
  return (contentType || '').split(';')[0].trim().toLowerCase();
}

function postDataOf(exchange: RecordedExchange): Record<string, unknown> | undefined {
  if (!exchange.requestBody) return undefined;
  return {
    mimeType: baseMimeType(headerValue(exchange.requestHeaders, 'content-type')) || 'text/plain',
    text: exchange.requestBody,
  };
}

/** One HAR entry. `time`, `content.mimeType` and `status` are all read downstream. */
export function toHarEntry(exchange: RecordedExchange): Record<string, unknown> {
  const postData = postDataOf(exchange);
  return {
    startedDateTime: exchange.startedAt.toISOString(),
    time: exchange.durationMs,
    request: {
      method: exchange.method,
      url: exchange.url,
      httpVersion: 'HTTP/1.1',
      headers: toNameValueList(exchange.requestHeaders),
      queryString: queryStringOf(exchange.url),
      cookies: [],
      headersSize: -1,
      bodySize: exchange.requestBytes,
      ...(postData ? { postData } : {}),
    },
    response: {
      status: exchange.status,
      statusText: exchange.statusText,
      httpVersion: 'HTTP/1.1',
      headers: toNameValueList(exchange.responseHeaders),
      cookies: [],
      // Gates `is_api_request`: without it every entry looks like a static
      // asset and the whole recording is filtered away as noise.
      content: {
        size: exchange.responseBytes,
        mimeType: baseMimeType(headerValue(exchange.responseHeaders, 'content-type')),
        ...(exchange.responseBody === null ? {} : { text: exchange.responseBody }),
      },
      redirectURL: headerValue(exchange.responseHeaders, 'location'),
      headersSize: -1,
      bodySize: exchange.responseBytes,
    },
    cache: {},
    timings: { send: 0, wait: exchange.durationMs, receive: 0 },
    // Not part of HAR 1.2. Kept so `cvx record` can report ingress and egress
    // separately, and ignored by any spec-compliant reader.
    _cognivoxDirection: exchange.direction,
  };
}

/** A complete HAR 1.2 document. */
export function toHar(
  exchanges: readonly RecordedExchange[],
  creatorVersion: string
): Record<string, unknown> {
  return {
    log: {
      version: '1.2',
      creator: { name: 'cognivox', version: creatorVersion },
      entries: exchanges.map(toHarEntry),
    },
  };
}
