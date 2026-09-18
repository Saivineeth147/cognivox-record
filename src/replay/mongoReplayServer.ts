/**
 * Answers an app's MongoDB commands from a recording.
 *
 * MongoDB's handshake is the wrinkle. A driver will not issue a single query
 * until it has negotiated with `hello`, decided the topology is usable, and
 * seen a wire-version range it supports — so a replay server that only knows
 * how to answer `find` never gets asked anything. The handshake is therefore
 * synthesised rather than replayed, and everything after it comes from the
 * recording.
 */

import * as net from 'net';
import { decodeDocument, encodeDocument, type BsonValue } from '../record/protocols/bson';
import { readMessage, commandNameOf } from '../record/protocols/mongoRecorder';
import type { DependencyInteraction } from '../record/tcp/protocol';

export const BIND_ADDRESS = '127.0.0.1';

const OP_MSG = 2013;
const OP_QUERY = 2004;
const OP_REPLY = 1;
const HEADER_BYTES = 16;

/** Commands the driver uses to negotiate, which must always succeed. */
const HANDSHAKE_COMMANDS = new Set(['hello', 'ismaster', 'isMaster', 'ping', 'buildInfo', 'buildinfo']);

/**
 * Bookkeeping the driver performs on its own behalf.
 *
 * These are never in a recording because no application calls them — the
 * driver sends them when closing sessions or cursors. Reporting them as
 * "no recording found" puts noise next to the genuine misses and teaches the
 * reader to skip the whole warning, which is how the real signal gets lost.
 */
const DRIVER_HOUSEKEEPING = new Set([
  'endSessions', 'killCursors', 'logout', 'abortTransaction',
  'getFreeMonitoringStatus', 'saslStart', 'saslContinue',
]);

/**
 * A standalone server the driver will accept.
 *
 * The wire version range must span what the driver supports or it refuses to
 * talk at all; 17 corresponds to MongoDB 7, which every current driver allows.
 */
function handshakeReply(): { [key: string]: BsonValue } {
  return {
    ok: 1,
    isWritablePrimary: true,
    ismaster: true,
    maxBsonObjectSize: 16777216,
    maxMessageSizeBytes: 48000000,
    maxWriteBatchSize: 100000,
    localTime: { $type: 'date', value: new Date().toISOString() },
    logicalSessionTimeoutMinutes: 30,
    minWireVersion: 0,
    maxWireVersion: 17,
    readOnly: false,
  };
}

/** Identity of a command for matching: its name and the collection it targets. */
export function signatureOf(document: { [key: string]: BsonValue }): string {
  const command = commandNameOf(document);
  const target = document[command];
  const filter = document.filter ? JSON.stringify(document.filter) : '';
  return `${command} ${typeof target === 'string' ? target : ''} ${filter}`.trim();
}

export class MongoReplay {
  private readonly byCommand = new Map<string, Record<string, unknown>[]>();
  private matchedCount = 0;
  private readonly missing = new Set<string>();

  constructor(interactions: readonly DependencyInteraction[]) {
    for (const interaction of interactions) {
      if (interaction.protocol !== 'mongodb') continue;
      const document = interaction.request.document as { [key: string]: BsonValue };
      const key = signatureOf(document ?? {});
      const existing = this.byCommand.get(key);
      if (existing) existing.push(interaction.response);
      else this.byCommand.set(key, [interaction.response]);
    }
  }

  /**
   * The reply for one command.
   *
   * An unrecorded command returns `ok: 0` with an explanation. MongoDB's own
   * shape for "no documents" is a successful reply with an empty cursor batch,
   * which a driver reports as simply finding nothing — indistinguishable from
   * a real empty collection, and exactly the silent pass this must avoid.
   */
  replyTo(document: { [key: string]: BsonValue }): { [key: string]: BsonValue } {
    const command = commandNameOf(document);
    if (HANDSHAKE_COMMANDS.has(command)) return handshakeReply();
    if (DRIVER_HOUSEKEEPING.has(command)) return { ok: 1 };

    const key = signatureOf(document);
    const recorded = this.byCommand.get(key);
    if (!recorded || recorded.length === 0) {
      this.missing.add(key);
      return {
        ok: 0, code: 59,
        errmsg: `cognivox has no recording for: ${key}`,
      };
    }
    this.matchedCount += 1;
    const reply = recorded.length > 1 ? recorded.shift() : recorded[0];
    return reply as { [key: string]: BsonValue };
  }

  stats(): { matched: number; unmatched: readonly string[] } {
    return { matched: this.matchedCount, unmatched: [...this.missing].sort() };
  }
}

function header(length: number, requestId: number, responseTo: number, opCode: number): Buffer {
  const bytes = Buffer.alloc(HEADER_BYTES);
  bytes.writeInt32LE(length, 0);
  bytes.writeInt32LE(requestId, 4);
  bytes.writeInt32LE(responseTo, 8);
  bytes.writeInt32LE(opCode, 12);
  return bytes;
}

/**
 * Frame a reply in the same form the request arrived in.
 *
 * An OP_QUERY must be answered with OP_REPLY. Answering the handshake with
 * OP_MSG — the modern form — leaves the driver unable to parse it, and it
 * gives up before asking anything else.
 */
function encodeReply(
  responseTo: number, requestId: number,
  body: { [key: string]: BsonValue }, requestOpCode: number
): Buffer {
  const document = encodeDocument(body);

  if (requestOpCode === OP_QUERY) {
    // responseFlags, cursorId (int64), startingFrom, numberReturned.
    const preamble = Buffer.alloc(20);
    preamble.writeInt32LE(8, 0);          // AwaitCapable
    preamble.writeBigInt64LE(0n, 4);      // no cursor
    preamble.writeInt32LE(0, 12);
    preamble.writeInt32LE(1, 16);         // one document follows
    const length = HEADER_BYTES + preamble.length + document.length;
    return Buffer.concat([
      header(length, requestId, responseTo, OP_REPLY), preamble, document,
    ]);
  }

  const section = Buffer.concat([Buffer.from([0]), document]);
  const flags = Buffer.alloc(4);
  const length = HEADER_BYTES + flags.length + section.length;
  return Buffer.concat([
    header(length, requestId, responseTo, OP_MSG), flags, section,
  ]);
}

/** Start a server that speaks MongoDB from `replay`. */
export function startMongoReplayServer(
  replay: MongoReplay,
  listenPort: number
): Promise<net.Server> {
  let nextRequestId = 1;
  const server = net.createServer((socket) => {
    let buffered: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      let offset = 0;
      for (;;) {
        const message = readMessage(buffered, offset);
        if (!message) break;
        offset += message.bytes;
        nextRequestId += 1;
        socket.write(encodeReply(
          message.requestId, nextRequestId,
          replay.replyTo(message.body), message.opCode
        ));
      }
      if (offset > 0) buffered = Buffer.from(buffered.subarray(offset));
    });
    socket.on('error', () => socket.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, BIND_ADDRESS, () => resolve(server));
  });
}

/** Re-export so the session can build documents without reaching into bson. */
export { decodeDocument };
