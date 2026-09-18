/**
 * Answers an app's SQL from a recording, so its tests run with no database.
 *
 * This speaks enough of the backend protocol for a real driver to connect and
 * query: the startup handshake, both query protocols, and result sets built
 * from what was recorded.
 *
 * As with Redis, an unrecorded statement is answered with an error rather than
 * an empty result set. Zero rows is a plausible answer that silently turns a
 * broken query into a passing test; an error is not plausible, which is
 * exactly why it is the right reply.
 */

import * as net from 'net';
import {
  readFrame, readStartup, readCString, readParse,
  readBindParameters, readBindStatement,
} from '../record/protocols/postgresMessages';
import * as encode from './postgresEncoder';
import type { ReplayColumn } from './postgresEncoder';
import type { DependencyInteraction } from '../record/tcp/protocol';
import type { DivergenceTracker } from './divergence';

export const BIND_ADDRESS = '127.0.0.1';

interface RecordedResult {
  readonly columns: ReplayColumn[];
  readonly rows: (string | null)[][];
  readonly tag: string;
  readonly error?: string;
}

/** Normalised so trivial whitespace differences still match. */
export function signatureOf(sql: string, params: readonly (string | null)[]): string {
  return `${sql.replace(/\s+/g, ' ').trim()}|${JSON.stringify(params)}`;
}

export class PostgresReplay {
  private readonly bySignature = new Map<string, RecordedResult[]>();
  private readonly bySql = new Map<string, RecordedResult[]>();
  private matchedCount = 0;
  private readonly missing = new Set<string>();

  /**
   * `tracker` is optional so the class stays testable on its own, but the
   * session always supplies one: without it a replay can serve a row from
   * before a write this run performed and nothing will ever say so.
   */
  constructor(
    interactions: readonly DependencyInteraction[],
    private readonly tracker?: DivergenceTracker
  ) {
    for (const interaction of interactions) {
      if (interaction.protocol !== 'postgres') continue;
      const sql = String(interaction.request.sql ?? '');
      const params = (interaction.request.params as (string | null)[]) ?? [];
      const response = interaction.response as unknown as RecordedResult;
      const result: RecordedResult = {
        columns: response.columns ?? [],
        rows: response.rows ?? [],
        tag: response.tag ?? '',
        error: response.error,
      };
      push(this.bySignature, signatureOf(sql, params), result);
      push(this.bySql, normalise(sql), result);
    }
  }

  /**
   * Find the recorded result for a statement.
   *
   * Exact parameters are preferred; the SQL alone is the fallback, because an
   * app replayed against a recording often binds an id it generated this run.
   * Falling back keeps those queries answerable instead of failing on a value
   * that was never going to match.
   */
  resultFor(sql: string, params: readonly (string | null)[]): RecordedResult | null {
    const found = this.lookup(sql, params);
    this.tracker?.observe(sql, found !== null);
    if (!found) {
      this.missing.add(normalise(sql));
      return null;
    }
    this.matchedCount += 1;
    return found;
  }

  /**
   * The same lookup without counting it.
   *
   * A Describe asks what a statement's columns will be before executing it, so
   * counting it as a matched query reports more queries answered than the app
   * actually ran.
   */
  peek(sql: string, params: readonly (string | null)[]): RecordedResult | null {
    return this.lookup(sql, params);
  }

  private lookup(
    sql: string, params: readonly (string | null)[]
  ): RecordedResult | null {
    const exact = this.bySignature.get(signatureOf(sql, params));
    const loose = this.bySql.get(normalise(sql));
    const found = (exact && exact.length > 0 ? exact : loose);
    if (!found || found.length === 0) return null;
    return found.length > 1 ? (found.shift() as RecordedResult) : found[0];
  }

  stats(): { matched: number; unmatched: string[] } {
    return { matched: this.matchedCount, unmatched: [...this.missing].sort() };
  }
}

function push(store: Map<string, RecordedResult[]>, key: string, value: RecordedResult): void {
  const existing = store.get(key);
  if (existing) existing.push(value);
  else store.set(key, [value]);
}

function normalise(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** Per-connection state for the extended query protocol. */
interface Session {
  readonly prepared: Map<string, string>;
  sql: string;
  params: (string | null)[];
  started: boolean;
}

/** The messages answering one statement, or an error if it was never recorded. */
function answerFor(
  replay: PostgresReplay, session: Session, includeDescription: boolean
): Buffer[] {
  const result = replay.resultFor(session.sql, session.params);
  if (!result) {
    return [encode.errorResponse(
      `cognivox has no recording for: ${normalise(session.sql)}`
    )];
  }
  if (result.error) return [encode.errorResponse(result.error)];

  const out: Buffer[] = [];
  if (includeDescription && result.columns.length > 0) {
    out.push(encode.rowDescription(result.columns));
  }
  for (const row of result.rows) out.push(encode.dataRow(row));
  out.push(encode.commandComplete(result.tag));
  return out;
}

function handleStartup(socket: net.Socket, buffered: Buffer, session: Session): Buffer {
  const startup = readStartup(buffered);
  if (startup.kind === 'incomplete') return buffered;
  if (startup.kind === 'ssl-request') {
    // Refuse TLS: there is nothing secret on a loopback replay socket, and a
    // driver set to `prefer` falls back to plaintext on this reply.
    socket.write(Buffer.from('N', 'ascii'));
    return Buffer.from(buffered.subarray(startup.bytes));
  }
  socket.write(Buffer.concat([
    encode.authenticationOk(),
    encode.parameterStatus('server_version', '16.0'),
    encode.parameterStatus('client_encoding', 'UTF8'),
    encode.backendKeyData(),
    encode.readyForQuery(),
  ]));
  session.started = true;
  return Buffer.from(buffered.subarray(startup.bytes));
}

function handleFrame(
  socket: net.Socket, type: string, payload: Buffer,
  replay: PostgresReplay, session: Session
): void {
  if (type === 'Q') {
    session.sql = readCString(payload, 0)[0];
    session.params = [];
    socket.write(Buffer.concat([...answerFor(replay, session, true), encode.readyForQuery()]));
    return;
  }
  if (type === 'P') {
    const { name, sql } = readParse(payload);
    session.prepared.set(name, sql);
    session.sql = sql;
    socket.write(encode.parseComplete());
    return;
  }
  if (type === 'B') {
    session.sql = session.prepared.get(readBindStatement(payload)) ?? session.sql;
    session.params = readBindParameters(payload);
    socket.write(encode.bindComplete());
    return;
  }
  if (type === 'D') {
    const result = replay.peek(session.sql, session.params);
    socket.write(result && result.columns.length > 0
      ? encode.rowDescription(result.columns)
      : encode.noData());
    return;
  }
  if (type === 'E') {
    socket.write(Buffer.concat(answerFor(replay, session, false)));
    return;
  }
  if (type === 'S') socket.write(encode.readyForQuery());
}

/** Start a server that speaks Postgres from `replay`. */
export function startPostgresReplayServer(
  replay: PostgresReplay, listenPort: number
): Promise<net.Server> {
  const server = net.createServer((socket) => {
    const session: Session = { prepared: new Map(), sql: '', params: [], started: false };
    let buffered: Buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!session.started) {
        const remaining = handleStartup(socket, buffered, session);
        if (remaining === buffered) return;
        buffered = remaining;
        if (!session.started) return;
      }
      let offset = 0;
      for (;;) {
        const frame = readFrame(buffered, offset);
        if (!frame) break;
        handleFrame(socket, frame.type, frame.payload, replay, session);
        offset += frame.bytes;
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
