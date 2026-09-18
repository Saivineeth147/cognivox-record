/**
 * Tests for dependency recording and replay.
 *
 * The parser tests feed bytes split at deliberately awkward points, because a
 * wire-protocol parser that assumes one message per chunk passes every naive
 * test and fails on the first large result set.
 */

import { decode, encode, toCommand, fromStored, type RespValue } from '../record/protocols/resp';
import { RedisRecorder } from '../record/protocols/redisRecorder';
import {
  readFrame, readStartup, readDataRow, readBindParameters, readRowDescription,
} from '../record/protocols/postgresMessages';
import { planRedirects } from '../record/dependencyEnv';
import { RedisReplay, signatureOf } from '../replay/redisReplayServer';
import { PostgresReplay } from '../replay/postgresReplayServer';
import type { DependencyInteraction } from '../record/tcp/protocol';

describe('RESP decoding', () => {
  it('should decode a bulk string', () => {
    expect(decode(Buffer.from('$5\r\nhello\r\n'))!.value).toEqual({ kind: 'bulk', value: 'hello' });
  });

  it('should decode a null bulk as null, not an empty string', () => {
    // `$-1` means "no value"; conflating it with "" changes what the app sees.
    expect(decode(Buffer.from('$-1\r\n'))!.value).toEqual({ kind: 'bulk', value: null });
  });

  it('should decode a nested array', () => {
    const decoded = decode(Buffer.from('*2\r\n$1\r\na\r\n:7\r\n'))!.value;
    expect(decoded).toEqual({
      kind: 'array',
      value: [{ kind: 'bulk', value: 'a' }, { kind: 'integer', value: 7 }],
    });
  });

  it('should return null for a value that has not fully arrived', () => {
    expect(decode(Buffer.from('$5\r\nhel'))).toBeNull();
  });

  it('should report how many bytes a value consumed, so the next one is found', () => {
    const buffer = Buffer.from('+OK\r\n:42\r\n');
    const first = decode(buffer)!;
    expect(decode(buffer, first.bytes)!.value).toEqual({ kind: 'integer', value: 42 });
  });

  it('should round-trip every value kind through encode', () => {
    const values: RespValue[] = [
      { kind: 'simple', value: 'OK' },
      { kind: 'error', value: 'ERR nope' },
      { kind: 'integer', value: -3 },
      { kind: 'bulk', value: 'hello' },
      { kind: 'bulk', value: null },
      { kind: 'array', value: [{ kind: 'bulk', value: 'x' }] },
    ];
    for (const value of values) {
      expect(decode(encode(value))!.value).toEqual(value);
    }
  });
});

describe('RedisRecorder', () => {
  it('should pair a command with its reply', () => {
    const recorder = new RedisRecorder();
    recorder.onClientData(Buffer.from('*2\r\n$3\r\nGET\r\n$1\r\nk\r\n'));
    recorder.onServerData(Buffer.from('$5\r\nvalue\r\n'));
    const [interaction] = recorder.drain();
    expect(interaction.request).toEqual({ command: 'GET', args: ['k'] });
    expect(interaction.response).toEqual({ kind: 'bulk', value: 'value' });
  });

  it('should pair correctly when a command arrives split across chunks', () => {
    const recorder = new RedisRecorder();
    const whole = Buffer.from('*2\r\n$3\r\nGET\r\n$1\r\nk\r\n');
    recorder.onClientData(whole.subarray(0, 7));
    recorder.onClientData(whole.subarray(7));
    recorder.onServerData(Buffer.from('$2\r\nhi\r\n'));
    expect(recorder.drain()[0].request).toEqual({ command: 'GET', args: ['k'] });
  });

  it('should keep pipelined commands in order', () => {
    const recorder = new RedisRecorder();
    recorder.onClientData(Buffer.from('*1\r\n$4\r\nPING\r\n*2\r\n$3\r\nGET\r\n$1\r\nk\r\n'));
    recorder.onServerData(Buffer.from('+PONG\r\n$1\r\nv\r\n'));
    const drained = recorder.drain();
    expect(drained.map((i) => i.request.command)).toEqual(['PING', 'GET']);
  });
});

describe('Postgres message framing', () => {
  it('should refuse a frame whose body has not arrived', () => {
    // 'C' with a declared length longer than the bytes present.
    expect(readFrame(Buffer.from([0x43, 0, 0, 0, 20, 1, 2]))).toBeNull();
  });

  it('should read a NULL column as null rather than an empty string', () => {
    const payload = Buffer.alloc(6);
    payload.writeInt16BE(1, 0);
    payload.writeInt32BE(-1, 2);
    expect(readDataRow(payload)).toEqual([null]);
  });

  it('should recognise an SSL request by its magic code', () => {
    const buffer = Buffer.alloc(8);
    buffer.writeInt32BE(8, 0);
    buffer.writeInt32BE(80877103, 4);
    expect(readStartup(buffer)).toEqual({ kind: 'ssl-request', bytes: 8 });
  });

  it('should keep the column type OID, which decides how a driver coerces', () => {
    const name = Buffer.from('id\0', 'utf8');
    const meta = Buffer.alloc(18);
    meta.writeInt32BE(23, 6);                 // int4
    const payload = Buffer.concat([Buffer.from([0, 1]), name, meta]);
    expect(readRowDescription(payload)).toEqual([{ name: 'id', typeOid: 23 }]);
  });

  it('should read bound parameters past the portal and statement names', () => {
    const payload = Buffer.concat([
      Buffer.from('\0\0', 'utf8'),           // unnamed portal, unnamed statement
      Buffer.from([0, 0]),                   // no format codes
      Buffer.from([0, 1]),                   // one parameter
      Buffer.from([0, 0, 0, 3]), Buffer.from('pro'),
    ]);
    expect(readBindParameters(payload)).toEqual(['pro']);
  });
});

describe('planRedirects', () => {
  it('should point a database URL at a local proxy', () => {
    const plan = planRedirects(
      { DATABASE_URL: 'postgres://u:p@db.internal:5432/app' }, 16790
    );
    expect(plan.env.DATABASE_URL).toBe('postgres://u:p@127.0.0.1:16790/app');
  });

  it('should keep credentials and database name, which the app authenticates with', () => {
    const plan = planRedirects(
      { DATABASE_URL: 'postgres://user:secret@host:5432/mydb?sslmode=disable' }, 16790
    );
    expect(plan.env.DATABASE_URL).toContain('user:secret@');
    expect(plan.env.DATABASE_URL).toContain('/mydb');
    expect(plan.env.DATABASE_URL).toContain('sslmode=disable');
  });

  it('should give each dependency its own port', () => {
    const plan = planRedirects(
      { DATABASE_URL: 'postgres://h:5432/a', REDIS_URL: 'redis://h:6379' }, 16790
    );
    const ports = plan.dependencies.map((d) => d.localPort).sort();
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('should apply the protocol default port when the URL omits one', () => {
    const plan = planRedirects({ REDIS_URL: 'redis://cache.internal' }, 16790);
    expect(plan.dependencies[0].upstreamPort).toBe(6379);
  });

  it('should flag a TLS redis URL as unreadable rather than pretending', () => {
    const plan = planRedirects({ REDIS_URL: 'rediss://cache.internal:6380' }, 16790);
    expect(plan.dependencies[0].encrypted).toBe(true);
  });

  it('should leave variables that are not connection strings alone', () => {
    const plan = planRedirects({ PATH: '/bin', HOME: '/root' }, 16790);
    expect(plan.dependencies).toHaveLength(0);
    expect(plan.env.PATH).toBe('/bin');
  });
});

function redisInteraction(command: string, args: string[], response: RespValue): DependencyInteraction {
  return {
    protocol: 'redis', request: { command, args },
    response: response as unknown as Record<string, unknown>, durationMs: 1,
  };
}

describe('RedisReplay', () => {
  it('should answer a recorded command', () => {
    const replay = new RedisReplay([
      redisInteraction('GET', ['k'], { kind: 'bulk', value: 'v' }),
    ]);
    expect(replay.replyTo('GET', ['k'])).toEqual({ kind: 'bulk', value: 'v' });
  });

  it('should answer repeated calls in the order they were recorded', () => {
    const replay = new RedisReplay([
      redisInteraction('INCR', ['c'], { kind: 'integer', value: 1 }),
      redisInteraction('INCR', ['c'], { kind: 'integer', value: 2 }),
    ]);
    expect(replay.replyTo('INCR', ['c'])).toEqual({ kind: 'integer', value: 1 });
    expect(replay.replyTo('INCR', ['c'])).toEqual({ kind: 'integer', value: 2 });
  });

  it('should repeat the last reply once the recording is exhausted', () => {
    const replay = new RedisReplay([
      redisInteraction('INCR', ['c'], { kind: 'integer', value: 1 }),
    ]);
    replay.replyTo('INCR', ['c']);
    expect(replay.replyTo('INCR', ['c'])).toEqual({ kind: 'integer', value: 1 });
  });

  it('should error on an unrecorded command instead of returning nil', () => {
    // A nil is a plausible answer, and a plausible wrong answer turns a real
    // regression into a passing test. An error cannot be mistaken for data.
    const replay = new RedisReplay([]);
    const reply = replay.replyTo('GET', ['never']);
    expect(reply.kind).toBe('error');
    expect(String(reply.value)).toContain('no recording');
  });

  it('should report which commands had no recording', () => {
    const replay = new RedisReplay([]);
    replay.replyTo('GET', ['ghost']);
    expect(replay.stats().unmatched).toEqual(['GET ghost']);
  });

  it('should rebuild stored replies including nested arrays', () => {
    const stored = { kind: 'array', value: [{ kind: 'bulk', value: 'x' }] };
    expect(fromStored(stored)).toEqual({ kind: 'array', value: [{ kind: 'bulk', value: 'x' }] });
  });
});

describe('PostgresReplay', () => {
  const interactions: DependencyInteraction[] = [{
    protocol: 'postgres',
    request: { sql: 'SELECT id FROM users WHERE tier = $1', params: ['pro'] },
    response: { columns: [{ name: 'id', typeOid: 23 }], rows: [['1']], tag: 'SELECT 1' },
    durationMs: 1,
  }];

  it('should match on SQL and parameters together', () => {
    const replay = new PostgresReplay(interactions);
    expect(replay.resultFor('SELECT id FROM users WHERE tier = $1', ['pro'])!.tag).toBe('SELECT 1');
  });

  it('should ignore whitespace differences in the SQL', () => {
    const replay = new PostgresReplay(interactions);
    expect(replay.resultFor('SELECT id  FROM   users WHERE tier = $1', ['pro'])).not.toBeNull();
  });

  it('should fall back to the SQL when parameters differ', () => {
    // An app replayed against a recording often binds an id it generated this
    // run; failing on that would make most recordings unusable.
    const replay = new PostgresReplay(interactions);
    expect(replay.resultFor('SELECT id FROM users WHERE tier = $1', ['free'])).not.toBeNull();
  });

  it('should return null for a statement that was never recorded', () => {
    const replay = new PostgresReplay(interactions);
    expect(replay.resultFor('SELECT * FROM ghosts', [])).toBeNull();
  });

  it('should not count a Describe as a query the app ran', () => {
    const replay = new PostgresReplay(interactions);
    replay.peek('SELECT id FROM users WHERE tier = $1', ['pro']);
    expect(replay.stats().matched).toBe(0);
  });
});

describe('signatureOf', () => {
  it('should make command identity case-insensitive on the verb', () => {
    expect(signatureOf('get', ['k'])).toBe(signatureOf('GET', ['k']));
  });
});
