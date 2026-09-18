/**
 * The subset of BSON needed to read and write MongoDB commands.
 *
 * MongoDB carries every request and reply as BSON documents, so recording it
 * at the wire level is mostly a decoding problem. This implements the types a
 * command and its reply actually use; anything else is preserved as a labelled
 * placeholder rather than dropped, so an unrecognised field cannot silently
 * become absent.
 *
 * Written rather than pulled from the driver package because the recorder must
 * work against an app's MongoDB without Cognivox depending on a MongoDB driver.
 */

/** BSON element type bytes, per the specification. */
const TYPE = {
  DOUBLE: 0x01, STRING: 0x02, DOCUMENT: 0x03, ARRAY: 0x04, BINARY: 0x05,
  UNDEFINED: 0x06, OBJECT_ID: 0x07, BOOLEAN: 0x08, DATE: 0x09, NULL: 0x0a,
  REGEX: 0x0b, INT32: 0x10, TIMESTAMP: 0x11, INT64: 0x12, DECIMAL: 0x13,
} as const;

/** Values that have no JSON equivalent keep their type in a tagged wrapper. */
export interface TaggedValue {
  readonly $type: string;
  readonly value: string;
}

export type BsonValue =
  | null | boolean | number | string
  | BsonValue[] | { [key: string]: BsonValue } | TaggedValue;

interface ReadResult {
  readonly value: BsonValue;
  readonly offset: number;
}

function readCString(buffer: Buffer, offset: number): [string, number] {
  const end = buffer.indexOf(0, offset);
  return [buffer.toString('utf8', offset, end), end + 1];
}

function readString(buffer: Buffer, offset: number): [string, number] {
  const length = buffer.readInt32LE(offset);
  // The declared length includes the terminating null, which is not content.
  return [buffer.toString('utf8', offset + 4, offset + 4 + length - 1), offset + 4 + length];
}

function readElement(buffer: Buffer, type: number, offset: number): ReadResult {
  switch (type) {
    case TYPE.DOUBLE: return { value: buffer.readDoubleLE(offset), offset: offset + 8 };
    case TYPE.STRING: {
      const [value, next] = readString(buffer, offset);
      return { value, offset: next };
    }
    case TYPE.DOCUMENT:
    case TYPE.ARRAY: {
      const size = buffer.readInt32LE(offset);
      const nested = decodeDocument(buffer, offset);
      return {
        value: type === TYPE.ARRAY ? Object.values(nested) : nested,
        offset: offset + size,
      };
    }
    case TYPE.BINARY: {
      const size = buffer.readInt32LE(offset);
      const value: TaggedValue = {
        $type: 'binary',
        value: buffer.toString('base64', offset + 5, offset + 5 + size),
      };
      return { value, offset: offset + 5 + size };
    }
    case TYPE.OBJECT_ID: {
      const value: TaggedValue = {
        $type: 'objectId',
        value: buffer.toString('hex', offset, offset + 12),
      };
      return { value, offset: offset + 12 };
    }
    case TYPE.BOOLEAN: return { value: buffer[offset] === 1, offset: offset + 1 };
    case TYPE.DATE: {
      const value: TaggedValue = {
        $type: 'date',
        value: new Date(Number(buffer.readBigInt64LE(offset))).toISOString(),
      };
      return { value, offset: offset + 8 };
    }
    case TYPE.NULL:
    case TYPE.UNDEFINED: return { value: null, offset };
    case TYPE.INT32: return { value: buffer.readInt32LE(offset), offset: offset + 4 };
    case TYPE.TIMESTAMP:
    case TYPE.INT64: {
      const raw = buffer.readBigInt64LE(offset);
      // Beyond 2^53 a JavaScript number silently loses precision, so large
      // 64-bit values keep their exact form as a string.
      const fits = raw <= BigInt(Number.MAX_SAFE_INTEGER) && raw >= BigInt(-Number.MAX_SAFE_INTEGER);
      const value: BsonValue = fits
        ? Number(raw)
        : { $type: 'long', value: raw.toString() };
      return { value, offset: offset + 8 };
    }
    case TYPE.REGEX: {
      const [pattern, afterPattern] = readCString(buffer, offset);
      const [flags, afterFlags] = readCString(buffer, afterPattern);
      return { value: { $type: 'regex', value: `/${pattern}/${flags}` }, offset: afterFlags };
    }
    case TYPE.DECIMAL: {
      const value: TaggedValue = {
        $type: 'decimal128',
        value: buffer.toString('hex', offset, offset + 16),
      };
      return { value, offset: offset + 16 };
    }
    default:
      // An unknown type has an unknown length, so the rest of the document
      // cannot be read. Reporting that is the only honest option — guessing a
      // width would produce confident nonsense for every field after it.
      throw new Error(`Unsupported BSON type 0x${type.toString(16)}`);
  }
}

/** Decode one document starting at `start`. */
export function decodeDocument(
  buffer: Buffer,
  start = 0
): { [key: string]: BsonValue } {
  const size = buffer.readInt32LE(start);
  const end = start + size - 1;
  const document: { [key: string]: BsonValue } = {};
  let offset = start + 4;

  while (offset < end) {
    const type = buffer[offset];
    if (type === 0) break;
    const [name, afterName] = readCString(buffer, offset + 1);
    const read = readElement(buffer, type, afterName);
    document[name] = read.value;
    offset = read.offset;
  }
  return document;
}

function encodeElement(name: string, value: BsonValue): Buffer {
  const key = Buffer.concat([Buffer.from(name, 'utf8'), Buffer.from([0])]);
  const tag = (type: number, body: Buffer) =>
    Buffer.concat([Buffer.from([type]), key, body]);

  if (value === null) return tag(TYPE.NULL, Buffer.alloc(0));
  if (typeof value === 'boolean') return tag(TYPE.BOOLEAN, Buffer.from([value ? 1 : 0]));
  if (typeof value === 'number') return encodeNumber(tag, value);
  if (typeof value === 'string') return tag(TYPE.STRING, encodeStringBody(value));
  if (Array.isArray(value)) {
    const asDocument = Object.fromEntries(value.map((item, index) => [String(index), item]));
    return tag(TYPE.ARRAY, encodeDocument(asDocument));
  }
  const tagged = value as TaggedValue;
  if (typeof tagged.$type === 'string') return encodeTagged(tag, tagged);
  return tag(TYPE.DOCUMENT, encodeDocument(value as { [key: string]: BsonValue }));
}

type Tagger = (type: number, body: Buffer) => Buffer;

function encodeNumber(tag: Tagger, value: number): Buffer {
  if (Number.isInteger(value) && Math.abs(value) <= 0x7fffffff) {
    const body = Buffer.alloc(4);
    body.writeInt32LE(value, 0);
    return tag(TYPE.INT32, body);
  }
  const body = Buffer.alloc(8);
  body.writeDoubleLE(value, 0);
  return tag(TYPE.DOUBLE, body);
}

function encodeStringBody(value: string): Buffer {
  const text = Buffer.from(value, 'utf8');
  const header = Buffer.alloc(4);
  header.writeInt32LE(text.length + 1, 0);
  return Buffer.concat([header, text, Buffer.from([0])]);
}

function encodeTagged(tag: Tagger, tagged: TaggedValue): Buffer {
  if (tagged.$type === 'objectId') return tag(TYPE.OBJECT_ID, Buffer.from(tagged.value, 'hex'));
  if (tagged.$type === 'date') {
    const body = Buffer.alloc(8);
    body.writeBigInt64LE(BigInt(new Date(tagged.value).getTime()), 0);
    return tag(TYPE.DATE, body);
  }
  if (tagged.$type === 'long') {
    const body = Buffer.alloc(8);
    body.writeBigInt64LE(BigInt(tagged.value), 0);
    return tag(TYPE.INT64, body);
  }
  if (tagged.$type === 'binary') {
    const raw = Buffer.from(tagged.value, 'base64');
    const header = Buffer.alloc(5);
    header.writeInt32LE(raw.length, 0);
    header[4] = 0;
    return tag(TYPE.BINARY, Buffer.concat([header, raw]));
  }
  // Anything else round-trips as a string rather than being dropped.
  return tag(TYPE.STRING, encodeStringBody(tagged.value));
}

/** Encode a document, including its length prefix and terminator. */
export function encodeDocument(document: { [key: string]: BsonValue }): Buffer {
  const elements = Object.entries(document).map(([name, value]) =>
    encodeElement(name, value));
  const body = Buffer.concat(elements);
  const header = Buffer.alloc(4);
  header.writeInt32LE(body.length + 5, 0);
  return Buffer.concat([header, body, Buffer.from([0])]);
}
