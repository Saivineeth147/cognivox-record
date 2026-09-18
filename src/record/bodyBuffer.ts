/**
 * Capturing a request or response body while it is relayed, without holding a
 * recording hostage to a large transfer.
 *
 * The body is piped straight through to its destination and only a bounded
 * prefix is retained for the recording. Buffering the whole body first — the
 * obvious implementation — means a single file download or video stream costs
 * the machine that much memory, and it stalls streaming responses until the
 * last byte arrives, which breaks server-sent events outright.
 *
 * When the cap is reached the retained copy is discarded rather than kept as a
 * prefix: half a JSON document produces assertions that are confidently wrong,
 * which is worse than recording no body at all.
 */

import type { Readable, Writable } from 'stream';

/** 2 MB holds any realistic API response and no realistic file download. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface CollectedBody {
  /** Body text, or null when it was too large or not decodable as text. */
  readonly text: string | null;
  /** Total bytes relayed, including any beyond the cap. */
  readonly totalBytes: number;
  /**
   * Bytes actually held in memory for the recording. Reported because the cap
   * is otherwise unobservable from outside: `text` is null whenever the body
   * was truncated, so a test asserting on it passes just as happily against an
   * implementation that buffers the entire transfer.
   */
  readonly retainedBytes: number;
  readonly truncated: boolean;
}

/**
 * Relay a body to its destination, retaining at most `maxBytes` for recording.
 *
 * Resolves when the source ends. The destination is written by `pipe`, so the
 * relay proceeds at the speed of the slower side and backpressure is honoured.
 */
export function captureAndForward(
  source: Readable,
  destination: Writable,
  maxBytes: number = MAX_BODY_BYTES
): Promise<CollectedBody> {
  return new Promise((resolve, reject) => {
    const retained: Buffer[] = [];
    let retainedBytes = 0;
    let totalBytes = 0;
    let truncated = false;

    source.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (truncated) return;
      if (retainedBytes + chunk.length > maxBytes) {
        // Stop retaining and drop what was kept: a partial body is not a
        // smaller recording, it is a wrong one.
        truncated = true;
        retained.length = 0;
        retainedBytes = 0;
        return;
      }
      retained.push(chunk);
      retainedBytes += chunk.length;
    });

    source.on('end', () => resolve({
      text: truncated ? null : decodeText(Buffer.concat(retained)),
      totalBytes,
      retainedBytes,
      truncated,
    }));
    source.on('error', reject);

    source.pipe(destination);
  });
}

/**
 * Binary bodies (images, protobuf, compressed payloads) have no useful text
 * form, and forcing one produces replacement characters that look downstream
 * like corrupted data the server actually sent.
 */
function decodeText(raw: Buffer): string | null {
  if (raw.length === 0) return null;
  const text = raw.toString('utf8');
  return text.includes('�') ? null : text;
}
