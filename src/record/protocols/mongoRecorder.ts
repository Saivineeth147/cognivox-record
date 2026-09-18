/**
 * Pairs MongoDB commands with their replies as they cross the proxy.
 *
 * Modern MongoDB carries everything in OP_MSG (opcode 2013): a header, flag
 * bits, then sections holding BSON. Unlike Redis, the protocol carries its own
 * correlation — every reply names the request id it answers — so pairing is by
 * identifier rather than by arrival order, which stays correct even when a
 * driver has several operations outstanding on one socket.
 */

import { decodeDocument, type BsonValue } from './bson';
import type { DependencyInteraction, ProtocolRecorder } from '../tcp/protocol';

const HEADER_BYTES = 16;
const OP_MSG = 2013;
/**
 * The legacy query opcode, still the first thing every driver sends.
 *
 * A driver cannot use OP_MSG until it knows the server's wire version, and it
 * learns that from the handshake — so the handshake itself must go out in the
 * older form. Treating 2004 as unparseable leaves the command document empty,
 * the handshake unanswerable, and no driver able to connect at all.
 */
const OP_QUERY = 2004;
const CHECKSUM_PRESENT = 1;
const CHECKSUM_BYTES = 4;
const SECTION_SINGLE_DOCUMENT = 0;
const SECTION_DOCUMENT_SEQUENCE = 1;

export interface MongoMessage {
  readonly requestId: number;
  readonly responseTo: number;
  readonly opCode: number;
  readonly body: { [key: string]: BsonValue };
  readonly bytes: number;
}

/** Read one framed message, or null when it has not fully arrived. */
export function readMessage(buffer: Buffer, offset = 0): MongoMessage | null {
  if (buffer.length < offset + HEADER_BYTES) return null;
  const length = buffer.readInt32LE(offset);
  if (length < HEADER_BYTES || buffer.length < offset + length) return null;

  const message = {
    requestId: buffer.readInt32LE(offset + 4),
    responseTo: buffer.readInt32LE(offset + 8),
    opCode: buffer.readInt32LE(offset + 12),
    bytes: length,
  };
  if (message.opCode === OP_MSG) {
    return { ...message, body: readSections(buffer, offset, length) };
  }
  if (message.opCode === OP_QUERY) {
    return { ...message, body: readQuery(buffer, offset) };
  }
  return { ...message, body: {} };
}

/**
 * Read the command document out of an OP_QUERY.
 *
 * Layout after the header: flags, the collection name, two int32 limits, then
 * the query document itself.
 */
function readQuery(buffer: Buffer, offset: number): { [key: string]: BsonValue } {
  const nameStart = offset + HEADER_BYTES + 4;
  const nameEnd = buffer.indexOf(0, nameStart);
  const documentStart = nameEnd + 1 + 8;
  if (documentStart >= buffer.length) return {};
  return decodeDocument(buffer, documentStart);
}

/**
 * Merge an OP_MSG's sections into one document.
 *
 * A driver may split a command: the command itself in a type 0 section and its
 * bulk arguments — the documents of an insert, say — in a type 1 sequence.
 * Reading only the first section would record an insert with no documents,
 * which replays as an insert of nothing.
 */
function readSections(
  buffer: Buffer, offset: number, length: number
): { [key: string]: BsonValue } {
  const flags = buffer.readUInt32LE(offset + HEADER_BYTES);
  const end = offset + length - ((flags & CHECKSUM_PRESENT) ? CHECKSUM_BYTES : 0);
  let cursor = offset + HEADER_BYTES + 4;
  let body: { [key: string]: BsonValue } = {};

  while (cursor < end) {
    const kind = buffer[cursor];
    cursor += 1;
    if (kind === SECTION_SINGLE_DOCUMENT) {
      const size = buffer.readInt32LE(cursor);
      body = { ...body, ...decodeDocument(buffer, cursor) };
      cursor += size;
      continue;
    }
    if (kind === SECTION_DOCUMENT_SEQUENCE) {
      const sectionSize = buffer.readInt32LE(cursor);
      const sectionEnd = cursor + sectionSize;
      const nameEnd = buffer.indexOf(0, cursor + 4);
      const identifier = buffer.toString('utf8', cursor + 4, nameEnd);
      const documents: BsonValue[] = [];
      let documentCursor = nameEnd + 1;
      while (documentCursor < sectionEnd) {
        const size = buffer.readInt32LE(documentCursor);
        documents.push(decodeDocument(buffer, documentCursor));
        documentCursor += size;
      }
      body[identifier] = documents;
      cursor = sectionEnd;
      continue;
    }
    break;
  }
  return body;
}

/** The command name is the first key of a MongoDB command document. */
export function commandNameOf(body: { [key: string]: BsonValue }): string {
  return Object.keys(body)[0] ?? '';
}

interface PendingCommand {
  readonly body: { [key: string]: BsonValue };
  readonly sentAt: number;
}

export class MongoRecorder implements ProtocolRecorder {
  readonly protocol = 'mongodb';

  private clientBuffer: Buffer = Buffer.alloc(0);
  private serverBuffer: Buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, PendingCommand>();
  private completed: DependencyInteraction[] = [];

  onClientData(chunk: Buffer): void {
    this.clientBuffer = consume(
      Buffer.concat([this.clientBuffer, chunk]),
      (message) => this.pending.set(message.requestId, {
        body: message.body, sentAt: Date.now(),
      })
    );
  }

  onServerData(chunk: Buffer): void {
    this.serverBuffer = consume(
      Buffer.concat([this.serverBuffer, chunk]),
      (message) => {
        const awaiting = this.pending.get(message.responseTo);
        if (!awaiting) return;
        this.pending.delete(message.responseTo);
        this.completed.push({
          protocol: this.protocol,
          request: {
            command: commandNameOf(awaiting.body),
            document: awaiting.body as unknown as Record<string, unknown>,
          },
          response: message.body as unknown as Record<string, unknown>,
          durationMs: Date.now() - awaiting.sentAt,
        });
      }
    );
  }

  drain(): DependencyInteraction[] {
    const done = this.completed;
    this.completed = [];
    return done;
  }
}

function consume(buffer: Buffer, onMessage: (message: MongoMessage) => void): Buffer {
  let offset = 0;
  for (;;) {
    const message = readMessage(buffer, offset);
    if (!message) break;
    onMessage(message);
    offset += message.bytes;
  }
  return offset === 0 ? buffer : Buffer.from(buffer.subarray(offset));
}
