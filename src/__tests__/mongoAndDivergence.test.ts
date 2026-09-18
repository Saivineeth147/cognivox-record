/**
 * Tests for MongoDB recording and for divergence detection.
 *
 * The BSON cases assert against byte layouts from the specification rather
 * than against this codec's own output, since a codec that is wrong in the
 * same way twice round-trips perfectly and still cannot read a real driver.
 */

import { decodeDocument, encodeDocument, type BsonValue } from '../record/protocols/bson';
import { readMessage, commandNameOf, MongoRecorder } from '../record/protocols/mongoRecorder';
import { MongoReplay, signatureOf } from '../replay/mongoReplayServer';
import { DivergenceTracker, tableOf } from '../replay/divergence';
import type { DependencyInteraction } from '../record/tcp/protocol';

describe('BSON', () => {
  it('should decode a document laid out per the specification', () => {
    // { "a": 1 } — 12 bytes: length, int32 tag, key, value, terminator.
    const bytes = Buffer.from([
      0x0c, 0x00, 0x00, 0x00, 0x10, 0x61, 0x00,
      0x01, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(decodeDocument(bytes)).toEqual({ a: 1 });
  });

  it('should round-trip nested documents and arrays', () => {
    const document: { [key: string]: BsonValue } = {
      find: 'users', filter: { tier: 'pro' }, tags: ['a', 'b'], limit: 10,
    };
    expect(decodeDocument(encodeDocument(document))).toEqual(document);
  });

  it('should keep a 64-bit integer exact rather than losing precision', () => {
    // Beyond 2^53 a JavaScript number rounds, so the value is kept as text.
    const document = { big: { $type: 'long', value: '9007199254740993' } };
    expect(decodeDocument(encodeDocument(document))).toEqual(document);
  });

  it('should preserve an ObjectId as hex', () => {
    const document = { _id: { $type: 'objectId', value: '651f1e1c2a4b5c6d7e8f9012' } };
    expect(decodeDocument(encodeDocument(document))).toEqual(document);
  });

  it('should distinguish null from absent', () => {
    expect(decodeDocument(encodeDocument({ a: null }))).toEqual({ a: null });
  });

  it('should refuse an unknown type rather than guessing its width', () => {
    // Guessing a width would silently corrupt every field after it.
    const bytes = Buffer.from([0x0a, 0x00, 0x00, 0x00, 0x7f, 0x61, 0x00, 0x00, 0x00, 0x00]);
    expect(() => decodeDocument(bytes)).toThrow(/Unsupported BSON type/);
  });
});

/** Frame a command document as the driver would, for parser tests. */
function opMsg(document: { [key: string]: BsonValue }, requestId: number, responseTo = 0): Buffer {
  const section = Buffer.concat([Buffer.from([0]), encodeDocument(document)]);
  const header = Buffer.alloc(16);
  header.writeInt32LE(16 + 4 + section.length, 0);
  header.writeInt32LE(requestId, 4);
  header.writeInt32LE(responseTo, 8);
  header.writeInt32LE(2013, 12);
  return Buffer.concat([header, Buffer.alloc(4), section]);
}

describe('MongoDB framing', () => {
  it('should refuse a message that has not fully arrived', () => {
    const whole = opMsg({ ping: 1 }, 7);
    expect(readMessage(whole.subarray(0, whole.length - 3))).toBeNull();
  });

  it('should read the command document out of an OP_MSG', () => {
    expect(readMessage(opMsg({ find: 'users' }, 7))!.body).toEqual({ find: 'users' });
  });

  it('should take the command name from the first key', () => {
    expect(commandNameOf({ insert: 'users', documents: [] })).toBe('insert');
  });
});

/** Frame a command as OP_QUERY, the form every driver opens with. */
function opQuery(document: { [key: string]: BsonValue }, requestId: number): Buffer {
  const collection = Buffer.concat([Buffer.from('admin.$cmd', 'utf8'), Buffer.from([0])]);
  const body = Buffer.concat([
    Buffer.alloc(4),          // flags
    collection,
    Buffer.alloc(8),          // numberToSkip, numberToReturn
    encodeDocument(document),
  ]);
  const header = Buffer.alloc(16);
  header.writeInt32LE(16 + body.length, 0);
  header.writeInt32LE(requestId, 4);
  header.writeInt32LE(0, 8);
  header.writeInt32LE(2004, 12);
  return Buffer.concat([header, body]);
}

describe('the OP_QUERY handshake', () => {
  it('should read the command out of an OP_QUERY, not just OP_MSG', () => {
    // A driver cannot use OP_MSG until it knows the server's wire version, and
    // it learns that from the handshake — so the handshake itself arrives in
    // the legacy form. Returning an empty body for 2004 leaves the handshake
    // unanswerable and no driver able to connect at all.
    expect(readMessage(opQuery({ hello: 1, client: { driver: 'node' } }, 3))!.body)
      .toMatchObject({ hello: 1 });
  });

  it('should report the opcode so a reply can match the request form', () => {
    expect(readMessage(opQuery({ hello: 1 }, 3))!.opCode).toBe(2004);
    expect(readMessage(opMsg({ find: 'x' }, 3))!.opCode).toBe(2013);
  });
});

describe('MongoRecorder', () => {
  it('should pair a reply to its request by id, not by arrival order', () => {
    // A driver can have several operations outstanding; pairing by order would
    // attach the wrong reply as soon as one completes out of sequence.
    const recorder = new MongoRecorder();
    recorder.onClientData(opMsg({ find: 'users' }, 11));
    recorder.onClientData(opMsg({ find: 'orders' }, 12));
    recorder.onServerData(opMsg({ ok: 1, from: 'orders' }, 99, 12));
    recorder.onServerData(opMsg({ ok: 1, from: 'users' }, 98, 11));

    // Assert the *request* each reply was attached to. Checking only the
    // command name cannot distinguish two `find`s, so a recorder pairing by
    // arrival order passes that version of this test while mis-pairing both.
    const drained = recorder.drain();
    expect(drained[0].request.document).toMatchObject({ find: 'orders' });
    expect(drained[0].response).toMatchObject({ from: 'orders' });
    expect(drained[1].request.document).toMatchObject({ find: 'users' });
    expect(drained[1].response).toMatchObject({ from: 'users' });
  });

  it('should handle a message split across chunks', () => {
    const recorder = new MongoRecorder();
    const whole = opMsg({ find: 'users' }, 21);
    recorder.onClientData(whole.subarray(0, 10));
    recorder.onClientData(whole.subarray(10));
    recorder.onServerData(opMsg({ ok: 1 }, 90, 21));
    expect(recorder.drain()).toHaveLength(1);
  });
});

describe('MongoReplay', () => {
  const interactions: DependencyInteraction[] = [{
    protocol: 'mongodb',
    request: { command: 'find', document: { find: 'users', filter: { tier: 'pro' } } },
    response: { ok: 1, cursor: { firstBatch: [{ name: 'Ada' }] } },
    durationMs: 1,
  }];

  it('should answer the handshake so the driver will proceed', () => {
    // A driver issues no queries at all until it has negotiated a wire version.
    const reply = new MongoReplay([]).replyTo({ hello: 1 });
    expect(reply.ok).toBe(1);
    expect(reply.maxWireVersion).toBeGreaterThanOrEqual(17);
  });

  it('should answer a recorded command', () => {
    const replay = new MongoReplay(interactions);
    expect(replay.replyTo({ find: 'users', filter: { tier: 'pro' } }))
      .toMatchObject({ ok: 1 });
  });

  it('should fail an unrecorded command rather than return an empty batch', () => {
    // An empty cursor batch is MongoDB's own "found nothing", which a driver
    // reports as an ordinary empty result — the silent pass to avoid.
    const reply = new MongoReplay(interactions).replyTo({ find: 'ghosts' });
    expect(reply.ok).toBe(0);
    expect(String(reply.errmsg)).toContain('no recording');
  });

  it('should quietly satisfy the driver\'s own bookkeeping', () => {
    // No application calls endSessions; the driver sends it when closing.
    // Listing it beside the genuine misses teaches the reader to skip them all.
    const replay = new MongoReplay(interactions);
    expect(replay.replyTo({ endSessions: [] }).ok).toBe(1);
    expect(replay.stats().unmatched).toEqual([]);
  });

  it('should treat a different filter as a different command', () => {
    const replay = new MongoReplay(interactions);
    expect(replay.replyTo({ find: 'users', filter: { tier: 'free' } }).ok).toBe(0);
  });

  it('should include the filter in a command signature', () => {
    expect(signatureOf({ find: 'users', filter: { a: 1 } }))
      .not.toBe(signatureOf({ find: 'users', filter: { a: 2 } }));
  });
});

describe('tableOf', () => {
  it.each([
    ['INSERT INTO users (a) VALUES (1)', 'users'],
    ['UPDATE users SET a = 1', 'users'],
    ['DELETE FROM users WHERE id = 1', 'users'],
    ['SELECT * FROM users ORDER BY id', 'users'],
  ])('should find the table in %s', (sql, expected) => {
    expect(tableOf(sql)).toBe(expected);
  });
});

describe('DivergenceTracker', () => {
  it('should warn when a read follows a write this run performed', () => {
    const tracker = new DivergenceTracker();
    tracker.observe('INSERT INTO users (name) VALUES ($1)', true);
    const warning = tracker.observe('SELECT * FROM users', true);
    expect(warning?.kind).toBe('stale-read');
    expect(warning?.detail).toContain('users');
  });

  it('should not warn about a read of a table nothing wrote to', () => {
    const tracker = new DivergenceTracker();
    tracker.observe('INSERT INTO audit (a) VALUES (1)', true);
    expect(tracker.observe('SELECT * FROM users', true)).toBeNull();
  });

  it('should warn that an unrecorded write changes nothing', () => {
    const tracker = new DivergenceTracker();
    const warning = tracker.observe('INSERT INTO users (name) VALUES ($1)', false);
    expect(warning?.detail).toContain('changes nothing');
  });

  it.each([
    ['SELECT NOW()', 'clock'],
    ['SELECT RANDOM()', 'random'],
    ['INSERT INTO users (a) VALUES (1) RETURNING id', 'identifier'],
  ])('should flag %s as non-deterministic', (sql, expected) => {
    const warning = new DivergenceTracker().observe(sql, true);
    expect(warning?.detail).toContain(expected);
  });

  it('should report each distinct statement once, not once per call', () => {
    const tracker = new DivergenceTracker();
    tracker.observe('INSERT INTO users (a) VALUES (1)', true);
    tracker.observe('SELECT * FROM users', true);
    tracker.observe('SELECT * FROM users', true);
    expect(tracker.all()).toHaveLength(1);
  });
});
