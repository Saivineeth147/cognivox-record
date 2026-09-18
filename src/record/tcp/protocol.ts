/**
 * The contract every wire-protocol recorder implements.
 *
 * The TCP proxy relays bytes and knows nothing about what they mean; each
 * protocol decides how to turn the two byte streams into request/response
 * pairs. Keeping that split is what lets a parser be tested on its own against
 * a real server, rather than only through a live proxy.
 */

/** One recorded exchange with a dependency. */
export interface DependencyInteraction {
  readonly protocol: string;
  /** What the app asked for, in a protocol-specific but readable shape. */
  readonly request: Record<string, unknown>;
  /** What the dependency answered. */
  readonly response: Record<string, unknown>;
  readonly durationMs: number;
}

/**
 * Parsers are fed raw TCP chunks, which split messages at arbitrary points.
 * Every implementation must buffer and re-parse from the start of the pending
 * bytes: one that assumes a chunk is a whole message passes every small test
 * and fails on the first large result set.
 */
export interface ProtocolRecorder {
  readonly protocol: string;
  onClientData(chunk: Buffer): void;
  onServerData(chunk: Buffer): void;
  /** Completed pairs since the last call. */
  drain(): DependencyInteraction[];
}

/** Builds a recorder for one connection. */
export type ProtocolRecorderFactory = () => ProtocolRecorder;
