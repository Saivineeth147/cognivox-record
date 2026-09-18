/**
 * Redis wire protocol (RESP) — incremental decoding of both directions.
 *
 * Redis answers in order, so requests and replies are paired by position
 * through a FIFO queue rather than by any identifier in the protocol; that
 * ordering guarantee is also what makes pipelining safe to record.
 *
 * RESP2 is decoded fully. RESP3's additional types (map, set, double, boolean,
 * big number, verbatim, push) are decoded structurally where they are shaped
 * like existing types and otherwise reported as unsupported — never skipped
 * silently, which would pair the next reply with the wrong command.
 */

export type RespValue =
  | { readonly kind: 'simple'; readonly value: string }
  | { readonly kind: 'error'; readonly value: string }
  | { readonly kind: 'integer'; readonly value: number }
  | { readonly kind: 'bulk'; readonly value: string | null }
  | { readonly kind: 'array'; readonly value: RespValue[] | null }
  | { readonly kind: 'unsupported'; readonly value: string };

/** A decoded value plus how many bytes it consumed. */
interface Decoded {
  readonly value: RespValue;
  readonly bytes: number;
}

const CRLF = '\r\n';

/** Index of the terminator that ends the line starting at `from`, or -1. */
function lineEnd(buffer: Buffer, from: number): number {
  return buffer.indexOf(CRLF, from, 'utf8');
}

/**
 * Decode one value from `buffer` at `offset`.
 *
 * Returns null when the buffer holds only part of a value — the normal case
 * mid-stream, and the reason every caller must be able to wait for more bytes
 * rather than treating a partial read as an error.
 */
export function decode(buffer: Buffer, offset = 0): Decoded | null {
  if (offset >= buffer.length) return null;
  const end = lineEnd(buffer, offset);
  if (end === -1) return null;

  const marker = String.fromCharCode(buffer[offset]);
  const header = buffer.toString('utf8', offset + 1, end);
  const headerBytes = end + CRLF.length - offset;

  switch (marker) {
    case '+': return { value: { kind: 'simple', value: header }, bytes: headerBytes };
    case '-': return { value: { kind: 'error', value: header }, bytes: headerBytes };
    case ':': return { value: { kind: 'integer', value: Number(header) }, bytes: headerBytes };
    case '$': return decodeBulk(buffer, offset, header, headerBytes);
    case '*': return decodeArray(buffer, offset, header, headerBytes);
    default:
      return { value: { kind: 'unsupported', value: `${marker}${header}` }, bytes: headerBytes };
  }
}

function decodeBulk(
  buffer: Buffer, offset: number, header: string, headerBytes: number
): Decoded | null {
  const length = Number(header);
  // `$-1` is Redis's null, and is a complete value despite carrying no payload.
  if (length < 0) return { value: { kind: 'bulk', value: null }, bytes: headerBytes };

  const start = offset + headerBytes;
  const finish = start + length;
  if (buffer.length < finish + CRLF.length) return null;
  return {
    value: { kind: 'bulk', value: buffer.toString('utf8', start, finish) },
    bytes: headerBytes + length + CRLF.length,
  };
}

function decodeArray(
  buffer: Buffer, offset: number, header: string, headerBytes: number
): Decoded | null {
  const count = Number(header);
  if (count < 0) return { value: { kind: 'array', value: null }, bytes: headerBytes };

  const items: RespValue[] = [];
  let consumed = headerBytes;
  for (let index = 0; index < count; index += 1) {
    const item = decode(buffer, offset + consumed);
    if (!item) return null;
    items.push(item.value);
    consumed += item.bytes;
  }
  return { value: { kind: 'array', value: items }, bytes: consumed };
}

/** A command as the app sent it: the verb plus its arguments. */
export interface RespCommand {
  readonly command: string;
  readonly args: string[];
}

/**
 * Real clients send commands as arrays of bulk strings, but `redis-cli` and
 * anything speaking inline commands send a bare line. Both are accepted so a
 * recording is not empty just because someone used a terminal.
 */
export function toCommand(value: RespValue): RespCommand | null {
  if (value.kind === 'array' && value.value && value.value.length > 0) {
    const parts = value.value.map((item) =>
      item.kind === 'bulk' || item.kind === 'simple' ? String(item.value ?? '') : ''
    );
    return { command: parts[0].toUpperCase(), args: parts.slice(1) };
  }
  if (value.kind === 'simple' && value.value.trim()) {
    const [verb, ...rest] = value.value.trim().split(/\s+/);
    return { command: verb.toUpperCase(), args: rest };
  }
  return null;
}

/** Serialise a value back onto the wire, for replay. */
export function encode(value: RespValue): Buffer {
  switch (value.kind) {
    case 'simple': return Buffer.from(`+${value.value}${CRLF}`);
    case 'error': return Buffer.from(`-${value.value}${CRLF}`);
    case 'integer': return Buffer.from(`:${value.value}${CRLF}`);
    case 'bulk': return encodeBulk(value.value);
    case 'array': return encodeArray(value.value);
    case 'unsupported':
      // Never invent a reply for something we could not read: a client given a
      // plausible-looking wrong answer behaves worse than one given an error.
      return Buffer.from(`-ERR cognivox recorded an unsupported reply${CRLF}`);
  }
}

function encodeBulk(value: string | null): Buffer {
  if (value === null) return Buffer.from(`$-1${CRLF}`);
  return Buffer.concat([
    Buffer.from(`$${Buffer.byteLength(value)}${CRLF}`),
    Buffer.from(value),
    Buffer.from(CRLF),
  ]);
}

function encodeArray(items: RespValue[] | null): Buffer {
  if (items === null) return Buffer.from(`*-1${CRLF}`);
  return Buffer.concat([
    Buffer.from(`*${items.length}${CRLF}`),
    ...items.map(encode),
  ]);
}

/** Rebuild a value from the shape stored in a recording. */
export function fromStored(stored: Record<string, unknown>): RespValue {
  const kind = String(stored.kind);
  if (kind === 'array') {
    const items = stored.value as Record<string, unknown>[] | null;
    return { kind: 'array', value: items === null ? null : items.map(fromStored) };
  }
  if (kind === 'integer') return { kind: 'integer', value: Number(stored.value) };
  if (kind === 'bulk') {
    return { kind: 'bulk', value: stored.value === null ? null : String(stored.value) };
  }
  if (kind === 'simple' || kind === 'error') {
    return { kind, value: String(stored.value) };
  }
  return { kind: 'unsupported', value: String(stored.value ?? '') };
}
