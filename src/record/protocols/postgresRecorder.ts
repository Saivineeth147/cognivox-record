/**
 * Pairs SQL statements with their result sets as they cross the proxy.
 *
 * Postgres speaks two query protocols and both are handled: the simple one
 * ('Q' carries the SQL directly) and the extended one used by every serious
 * driver, where 'P' parses a statement, 'B' binds parameters to it and 'E'
 * executes it. Recording only the simple protocol would produce an empty
 * capture for virtually every real application.
 *
 * Results are assembled from 'T' (column names), any number of 'D' rows, and
 * 'C' (the command tag) which closes the statement and emits the interaction.
 */

import {
  readFrame, readStartup, readRowDescription, readDataRow,
  readBindParameters, readParse, readBindStatement, readCString,
} from './postgresMessages';
import type { PostgresColumn } from './postgresMessages';
import type { DependencyInteraction, ProtocolRecorder } from '../tcp/protocol';

/** What the connection is doing, which decides how bytes are read. */
type Phase = 'initial' | 'awaiting-ssl-reply' | 'running' | 'encrypted';

export class PostgresRecorder implements ProtocolRecorder {
  readonly protocol = 'postgres';

  private clientBuffer: Buffer = Buffer.alloc(0);
  private serverBuffer: Buffer = Buffer.alloc(0);
  private phase: Phase = 'initial';

  private readonly prepared = new Map<string, string>();
  private currentSql = '';
  private currentParams: (string | null)[] = [];
  private columns: PostgresColumn[] = [];
  private rows: (string | null)[][] = [];
  private startedAt = Date.now();
  private completed: DependencyInteraction[] = [];

  /** True once the connection upgraded to TLS and became unreadable. */
  encrypted = false;

  onClientData(chunk: Buffer): void {
    if (this.phase === 'encrypted') return;
    this.clientBuffer = Buffer.concat([this.clientBuffer, chunk]);

    if (this.phase === 'initial') {
      const startup = readStartup(this.clientBuffer);
      if (startup.kind === 'incomplete') return;
      this.clientBuffer = Buffer.from(this.clientBuffer.subarray(startup.bytes));
      this.phase = startup.kind === 'ssl-request' ? 'awaiting-ssl-reply' : 'running';
      if (this.phase === 'awaiting-ssl-reply') return;
    }
    if (this.phase !== 'running') return;

    let offset = 0;
    for (;;) {
      const frame = readFrame(this.clientBuffer, offset);
      if (!frame) break;
      this.handleClientFrame(frame.type, frame.payload);
      offset += frame.bytes;
    }
    if (offset > 0) this.clientBuffer = Buffer.from(this.clientBuffer.subarray(offset));
  }

  onServerData(chunk: Buffer): void {
    if (this.phase === 'encrypted') return;

    // The reply to an SSLRequest is a bare byte, not a framed message.
    if (this.phase === 'awaiting-ssl-reply') {
      if (chunk.length === 0) return;
      const accepted = String.fromCharCode(chunk[0]) === 'S';
      this.phase = accepted ? 'encrypted' : 'running';
      this.encrypted = accepted;
      // Everything after a TLS upgrade is ciphertext. Stopping here is what
      // lets the summary report "this connection was encrypted" rather than
      // reporting zero queries as though the app made none.
      if (accepted) return;
      this.serverBuffer = Buffer.from(chunk.subarray(1));
      return;
    }

    this.serverBuffer = Buffer.concat([this.serverBuffer, chunk]);
    let offset = 0;
    for (;;) {
      const frame = readFrame(this.serverBuffer, offset);
      if (!frame) break;
      this.handleServerFrame(frame.type, frame.payload);
      offset += frame.bytes;
    }
    if (offset > 0) this.serverBuffer = Buffer.from(this.serverBuffer.subarray(offset));
  }

  private handleClientFrame(type: string, payload: Buffer): void {
    if (type === 'Q') {
      [this.currentSql] = readCString(payload, 0);
      this.currentParams = [];
      this.startedAt = Date.now();
      return;
    }
    if (type === 'P') {
      const { name, sql } = readParse(payload);
      this.prepared.set(name, sql);
      this.currentSql = sql;
      this.startedAt = Date.now();
      return;
    }
    if (type === 'B') {
      const statement = readBindStatement(payload);
      // An unnamed statement was just parsed; a named one may have been
      // prepared on an earlier round trip, so fall back to the map.
      this.currentSql = this.prepared.get(statement) ?? this.currentSql;
      this.currentParams = readBindParameters(payload);
      this.startedAt = Date.now();
    }
  }

  private handleServerFrame(type: string, payload: Buffer): void {
    if (type === 'T') { this.columns = readRowDescription(payload); return; }
    if (type === 'D') { this.rows.push(readDataRow(payload)); return; }
    if (type === 'C') { this.emit(readCString(payload, 0)[0], null); return; }
    if (type === 'E') { this.emit('', readCString(payload, 1)[0]); }
  }

  private emit(tag: string, error: string | null): void {
    if (!this.currentSql) return;
    this.completed.push({
      protocol: this.protocol,
      request: { sql: this.currentSql, params: this.currentParams },
      response: error === null
        ? { columns: this.columns, rows: this.rows, tag }
        : { error },
      durationMs: Date.now() - this.startedAt,
    });
    this.columns = [];
    this.rows = [];
  }

  drain(): DependencyInteraction[] {
    const done = this.completed;
    this.completed = [];
    return done;
  }
}
