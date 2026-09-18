/**
 * Framing and field readers for the PostgreSQL v3 wire protocol.
 *
 * Kept separate from the recorder so the byte-level decoding can be tested on
 * captured frames directly. Everything here is pure: it reads, it never
 * buffers state.
 *
 * Message shape is `[1 byte type][Int32 length including itself][payload]`,
 * with one exception — the very first message a client sends has no type byte,
 * which is why `readStartup` exists separately.
 */

/** A framed message, ready to interpret. */
export interface PostgresFrame {
  /** Message type byte, or '' for the untyped startup message. */
  readonly type: string;
  readonly payload: Buffer;
  /** Bytes this frame occupied, so the caller can advance. */
  readonly bytes: number;
}

/** The magic protocol number a client sends to request TLS. */
export const SSL_REQUEST_CODE = 80877103;

const LENGTH_BYTES = 4;
const TYPE_BYTES = 1;

/**
 * Read one typed frame, or null when the buffer holds only part of one.
 *
 * Wire protocols split across TCP chunks at arbitrary points; returning null
 * and waiting is the normal path, not an error.
 */
export function readFrame(buffer: Buffer, offset = 0): PostgresFrame | null {
  if (buffer.length < offset + TYPE_BYTES + LENGTH_BYTES) return null;
  const length = buffer.readInt32BE(offset + TYPE_BYTES);
  const total = TYPE_BYTES + length;
  if (length < LENGTH_BYTES || buffer.length < offset + total) return null;
  return {
    type: String.fromCharCode(buffer[offset]),
    payload: buffer.subarray(offset + TYPE_BYTES + LENGTH_BYTES, offset + total),
    bytes: total,
  };
}

/** Result of inspecting the client's first message. */
export type StartupKind =
  | { readonly kind: 'ssl-request'; readonly bytes: number }
  | { readonly kind: 'startup'; readonly bytes: number }
  | { readonly kind: 'incomplete' };

/**
 * Classify the untyped first message.
 *
 * A client that asks for TLS and is refused falls back to plaintext when its
 * sslmode is `prefer`, which is the common default; one set to `require` will
 * fail instead. The recorder needs to know which happened so it can say so.
 */
export function readStartup(buffer: Buffer): StartupKind {
  if (buffer.length < LENGTH_BYTES * 2) return { kind: 'incomplete' };
  const length = buffer.readInt32BE(0);
  if (buffer.length < length) return { kind: 'incomplete' };
  const code = buffer.readInt32BE(LENGTH_BYTES);
  return code === SSL_REQUEST_CODE
    ? { kind: 'ssl-request', bytes: length }
    : { kind: 'startup', bytes: length };
}

/** Read a null-terminated string at `offset`; returns it and the next offset. */
export function readCString(payload: Buffer, offset: number): [string, number] {
  const end = payload.indexOf(0, offset);
  if (end === -1) return [payload.toString('utf8', offset), payload.length];
  return [payload.toString('utf8', offset, end), end + 1];
}

/** A column as the server described it. */
export interface PostgresColumn {
  readonly name: string;
  /**
   * The type OID matters on replay. Sending every column back as text makes a
   * driver hand the app `"1"` where the database gave it `1`, and arithmetic
   * on that silently produces `"11"` instead of `2`.
   */
  readonly typeOid: number;
}

/** Columns from a RowDescription ('T') payload. */
export function readRowDescription(payload: Buffer): PostgresColumn[] {
  const count = payload.readInt16BE(0);
  const columns: PostgresColumn[] = [];
  let offset = 2;
  for (let index = 0; index < count; index += 1) {
    const [name, next] = readCString(payload, offset);
    // Field metadata: table OID (4), column number (2), type OID (4),
    // type length (2), type modifier (4), format code (2) — 18 bytes.
    columns.push({ name, typeOid: payload.readInt32BE(next + 6) });
    offset = next + 18;
  }
  return columns;
}

/** Values from a DataRow ('D') payload. NULL is represented by length -1. */
export function readDataRow(payload: Buffer): (string | null)[] {
  const count = payload.readInt16BE(0);
  const values: (string | null)[] = [];
  let offset = 2;
  for (let index = 0; index < count; index += 1) {
    const length = payload.readInt32BE(offset);
    offset += 4;
    if (length < 0) {
      values.push(null);
      continue;
    }
    values.push(payload.toString('utf8', offset, offset + length));
    offset += length;
  }
  return values;
}

/** Bound parameter values from a Bind ('B') payload. */
export function readBindParameters(payload: Buffer): (string | null)[] {
  const [, afterPortal] = readCString(payload, 0);
  const [, afterStatement] = readCString(payload, afterPortal);
  let offset = afterStatement;

  const formatCount = payload.readInt16BE(offset);
  offset += 2 + formatCount * 2;

  const paramCount = payload.readInt16BE(offset);
  offset += 2;

  const values: (string | null)[] = [];
  for (let index = 0; index < paramCount; index += 1) {
    const length = payload.readInt32BE(offset);
    offset += 4;
    if (length < 0) {
      values.push(null);
      continue;
    }
    values.push(payload.toString('utf8', offset, offset + length));
    offset += length;
  }
  return values;
}

/** Statement name and SQL from a Parse ('P') payload. */
export function readParse(payload: Buffer): { name: string; sql: string } {
  const [name, afterName] = readCString(payload, 0);
  const [sql] = readCString(payload, afterName);
  return { name, sql };
}

/** Prepared-statement name a Bind ('B') refers to. */
export function readBindStatement(payload: Buffer): string {
  const [, afterPortal] = readCString(payload, 0);
  const [statement] = readCString(payload, afterPortal);
  return statement;
}
