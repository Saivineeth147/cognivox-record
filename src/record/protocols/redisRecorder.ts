/**
 * Pairs Redis commands with their replies as they cross the proxy.
 *
 * Redis guarantees replies arrive in the order the commands were sent, so a
 * FIFO queue is the whole matching strategy — no request identifiers exist in
 * the protocol to match on. That same guarantee is what makes pipelined
 * commands (several sent before any reply) record correctly here.
 */

import { decode, toCommand, type RespCommand, type RespValue } from './resp';
import type { DependencyInteraction, ProtocolRecorder } from '../tcp/protocol';

/** A command awaiting its reply. */
interface PendingCommand {
  readonly command: RespCommand;
  readonly sentAt: number;
}

export class RedisRecorder implements ProtocolRecorder {
  readonly protocol = 'redis';

  private clientBuffer: Buffer = Buffer.alloc(0);
  private serverBuffer: Buffer = Buffer.alloc(0);
  private readonly pending: PendingCommand[] = [];
  private completed: DependencyInteraction[] = [];

  onClientData(chunk: Buffer): void {
    this.clientBuffer = Buffer.concat([this.clientBuffer, chunk]);
    this.clientBuffer = consume(this.clientBuffer, (value) => {
      const command = toCommand(value);
      if (command) this.pending.push({ command, sentAt: Date.now() });
    });
  }

  onServerData(chunk: Buffer): void {
    this.serverBuffer = Buffer.concat([this.serverBuffer, chunk]);
    this.serverBuffer = consume(this.serverBuffer, (value) => {
      const awaiting = this.pending.shift();
      // A reply with nothing waiting means the stream desynchronised — a
      // pushed pub/sub message, or a command shape we failed to decode.
      // Recording it against the wrong command would be worse than dropping it.
      if (!awaiting) return;
      this.completed.push({
        protocol: this.protocol,
        request: { command: awaiting.command.command, args: awaiting.command.args },
        response: describe(value),
        durationMs: Date.now() - awaiting.sentAt,
      });
    });
  }

  drain(): DependencyInteraction[] {
    const done = this.completed;
    this.completed = [];
    return done;
  }
}

/**
 * Decode as many whole values as the buffer holds, returning what is left.
 *
 * Returning the remainder rather than mutating a field is what keeps a
 * half-arrived value safe: it stays buffered until the rest of it lands.
 */
function consume(buffer: Buffer, onValue: (value: RespValue) => void): Buffer {
  let offset = 0;
  for (;;) {
    const decoded = decode(buffer, offset);
    if (!decoded) break;
    onValue(decoded.value);
    offset += decoded.bytes;
  }
  // `Buffer.from` copies rather than `subarray`, which would return a view
  // that keeps the entire original buffer alive. On a long-lived connection
  // that turns a few leftover bytes into a retained megabyte.
  return offset === 0 ? buffer : Buffer.from(buffer.subarray(offset));
}

/** Flatten a reply into the shape stored in the recording. */
export function describe(value: RespValue): Record<string, unknown> {
  if (value.kind === 'array') {
    return {
      kind: 'array',
      value: value.value === null ? null : value.value.map(describe),
    };
  }
  return { kind: value.kind, value: value.value };
}
