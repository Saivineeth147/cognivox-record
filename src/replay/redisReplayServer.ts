/**
 * Answers an app's Redis commands from a recording, so its tests run with no
 * Redis present.
 *
 * The matching rule is the whole design. A command is identified by its verb
 * and arguments; repeated calls to the same command are answered in the order
 * they were recorded, which is what makes a counter that returned 1 then 2
 * replay as 1 then 2 rather than 1 twice.
 *
 * An unrecorded command is answered with an error, never with a plausible
 * empty value. Returning nil for a GET nobody recorded is how a mock turns a
 * real regression into a passing test — the worst thing this could do.
 */

import * as net from 'net';
import { decode, encode, toCommand, fromStored, type RespValue } from '../record/protocols/resp';
import type { DependencyInteraction } from '../record/tcp/protocol';

export const BIND_ADDRESS = '127.0.0.1';

/** Recorded replies for one command signature, answered in order. */
interface ReplySequence {
  readonly replies: RespValue[];
  next: number;
}

export interface ReplayStats {
  readonly matched: number;
  readonly unmatched: readonly string[];
}

/** `GET user:7` — the identity a recorded reply is filed under. */
export function signatureOf(command: string, args: readonly string[]): string {
  return [command.toUpperCase(), ...args].join(' ');
}

export class RedisReplay {
  private readonly sequences = new Map<string, ReplySequence>();
  private matchedCount = 0;
  private readonly missing = new Set<string>();

  constructor(interactions: readonly DependencyInteraction[]) {
    for (const interaction of interactions) {
      if (interaction.protocol !== 'redis') continue;
      const command = String(interaction.request.command ?? '');
      const args = (interaction.request.args as string[]) ?? [];
      const key = signatureOf(command, args);
      const existing = this.sequences.get(key);
      const reply = fromStored(interaction.response);
      if (existing) existing.replies.push(reply);
      else this.sequences.set(key, { replies: [reply], next: 0 });
    }
  }

  /**
   * The reply for one command.
   *
   * Once a sequence is exhausted its last reply repeats: an app that polls a
   * key more times than the recording saw should keep getting the value it
   * last had, rather than falling off the end into an error.
   */
  replyTo(command: string, args: readonly string[]): RespValue {
    const key = signatureOf(command, args);
    const sequence = this.sequences.get(key);
    if (!sequence) {
      this.missing.add(key);
      return {
        kind: 'error',
        value: `ERR cognivox has no recording for: ${key}`,
      };
    }
    this.matchedCount += 1;
    const index = Math.min(sequence.next, sequence.replies.length - 1);
    sequence.next += 1;
    return sequence.replies[index];
  }

  stats(): ReplayStats {
    return { matched: this.matchedCount, unmatched: [...this.missing].sort() };
  }
}

/** Start a server that speaks Redis from `replay`. */
export function startRedisReplayServer(
  replay: RedisReplay,
  listenPort: number
): Promise<net.Server> {
  const server = net.createServer((socket) => {
    let buffered: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      let offset = 0;
      for (;;) {
        const decoded = decode(buffered, offset);
        if (!decoded) break;
        offset += decoded.bytes;
        const command = toCommand(decoded.value);
        if (command) {
          socket.write(encode(replay.replyTo(command.command, command.args)));
        }
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
