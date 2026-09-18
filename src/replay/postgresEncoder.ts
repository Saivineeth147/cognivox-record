/**
 * Builds PostgreSQL backend messages, so replay can answer a real driver.
 *
 * Every value is sent with the text type OID. That is not a shortcut: the
 * recorder reads every column as text off the wire, so claiming an integer OID
 * here would tell the driver to parse values we never verified were integers.
 * Text in, text out, and the driver's own coercion does the rest.
 */

/** Used only when a recording predates column type capture. */
const TEXT_TYPE_OID = 25;
const VARIABLE_LENGTH = -1;
const TEXT_FORMAT = 0;

/** Frame a payload as `[type][Int32 length including itself][payload]`. */
function message(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.write(type, 0, 'ascii');
  header.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([header, payload]);
}

function cstring(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])]);
}

/** Authentication succeeded — the zero means "no further challenge". */
export function authenticationOk(): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeInt32BE(0, 0);
  return message('R', payload);
}

export function parameterStatus(name: string, value: string): Buffer {
  return message('S', Buffer.concat([cstring(name), cstring(value)]));
}

export function backendKeyData(): Buffer {
  const payload = Buffer.alloc(8);
  payload.writeInt32BE(1, 0);
  payload.writeInt32BE(1, 4);
  return message('K', payload);
}

/** 'I' means idle, outside any transaction. */
export function readyForQuery(): Buffer {
  return message('Z', Buffer.from('I', 'ascii'));
}

export function parseComplete(): Buffer { return message('1', Buffer.alloc(0)); }
export function bindComplete(): Buffer { return message('2', Buffer.alloc(0)); }
export function noData(): Buffer { return message('n', Buffer.alloc(0)); }

/** A column to describe back to the driver. */
export interface ReplayColumn {
  readonly name: string;
  readonly typeOid?: number;
}

/**
 * Column headers, carrying the type OIDs the database originally reported so
 * the driver coerces values exactly as it did during recording.
 */
export function rowDescription(columns: readonly ReplayColumn[]): Buffer {
  const count = Buffer.alloc(2);
  count.writeInt16BE(columns.length, 0);
  const fields = columns.map(({ name, typeOid }) => {
    const meta = Buffer.alloc(18);
    meta.writeInt32BE(0, 0);                    // table OID: not from a table
    meta.writeInt16BE(0, 4);                    // column number
    meta.writeInt32BE(typeOid ?? TEXT_TYPE_OID, 6);
    meta.writeInt16BE(VARIABLE_LENGTH, 10);
    meta.writeInt32BE(VARIABLE_LENGTH, 12);
    meta.writeInt16BE(TEXT_FORMAT, 16);
    return Buffer.concat([cstring(name), meta]);
  });
  return message('T', Buffer.concat([count, ...fields]));
}

/** One row. A null column is sent as length -1 with no bytes, per the protocol. */
export function dataRow(values: readonly (string | null)[]): Buffer {
  const count = Buffer.alloc(2);
  count.writeInt16BE(values.length, 0);
  const columns = values.map((value) => {
    if (value === null) {
      const nullColumn = Buffer.alloc(4);
      nullColumn.writeInt32BE(VARIABLE_LENGTH, 0);
      return nullColumn;
    }
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(4);
    length.writeInt32BE(bytes.length, 0);
    return Buffer.concat([length, bytes]);
  });
  return message('D', Buffer.concat([count, ...columns]));
}

export function commandComplete(tag: string): Buffer {
  return message('C', cstring(tag));
}

/**
 * An error the driver will raise as an exception.
 *
 * Severity, SQLSTATE and message are the three fields drivers require; a
 * response missing any of them is reported as a protocol violation instead of
 * the error we meant to convey.
 */
export function errorResponse(text: string): Buffer {
  const payload = Buffer.concat([
    Buffer.from('S'), cstring('ERROR'),
    Buffer.from('C'), cstring('P0001'),
    Buffer.from('M'), cstring(text),
    Buffer.from([0]),
  ]);
  return message('E', payload);
}
