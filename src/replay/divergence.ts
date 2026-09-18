/**
 * Detects the two ways a replay can quietly stop reflecting reality.
 *
 * Neither can be *fixed* without becoming a database. Answering a `SELECT`
 * correctly after an `INSERT` the recording never saw would mean executing SQL
 * — a query planner, a transaction model, and every dialect difference that
 * comes with them — and `NOW()` cannot return the current time and the recorded
 * time at once. Keploy does not solve these either.
 *
 * What is achievable is refusing to be silent about them. A replay that serves
 * a stale row is indistinguishable from a passing test; a replay that says
 * "this SELECT follows an INSERT that was not recorded" is a diagnosis.
 */

/** SQL whose result cannot be the same twice, however faithfully replayed. */
const NON_DETERMINISTIC = [
  { pattern: /\bNOW\s*\(\)|\bCURRENT_TIMESTAMP\b|\bCURRENT_DATE\b/i, reason: 'reads the clock' },
  { pattern: /\bRANDOM\s*\(\)|\bGEN_RANDOM_UUID\s*\(\)/i, reason: 'is random' },
  { pattern: /\bNEXTVAL\s*\(|\bRETURNING\s+/i, reason: 'allocates an identifier' },
];

const WRITE_STATEMENT = /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b/i;
const READ_STATEMENT = /^\s*(SELECT|WITH)\b/i;

/** The table a statement touches, as far as it can be read without parsing SQL. */
export function tableOf(sql: string): string | null {
  const match = sql.match(
    /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|FROM|JOIN)\s+["`]?([A-Za-z_][A-Za-z0-9_.$]*)/i
  );
  return match ? match[1].toLowerCase() : null;
}

export interface DivergenceWarning {
  readonly kind: 'stale-read' | 'non-deterministic';
  readonly statement: string;
  readonly detail: string;
}

/**
 * Tracks what a replayed run has written, so reads of the same table can be
 * flagged.
 *
 * Only writes performed *during this replay* count. A write that was part of
 * the recording is already reflected in the rows recorded after it, so warning
 * about those would bury the real signal in noise.
 */
export class DivergenceTracker {
  private readonly writtenTables = new Set<string>();
  private readonly warnings: DivergenceWarning[] = [];
  private readonly seen = new Set<string>();

  /** Note a statement the app ran, returning any warning it raises. */
  observe(sql: string, wasRecorded: boolean): DivergenceWarning | null {
    const warning = this.evaluate(sql, wasRecorded);
    if (!warning) return null;
    const key = `${warning.kind}:${warning.statement}`;
    if (this.seen.has(key)) return null;
    this.seen.add(key);
    this.warnings.push(warning);
    return warning;
  }

  /**
   * Determinism is a property of the statement text and is independent of
   * whether the statement reads or writes. Checking it only on the read path —
   * the obvious structure — misses `INSERT ... RETURNING id`, which is both a
   * write and the most common non-deterministic statement there is.
   */
  private evaluate(sql: string, wasRecorded: boolean): DivergenceWarning | null {
    const table = tableOf(sql);
    const isWrite = WRITE_STATEMENT.test(sql);
    if (isWrite && table) this.writtenTables.add(table);

    // Most severe first: a write that does nothing invalidates everything
    // downstream of it, a stale read is wrong data, and non-determinism is a
    // value that merely will not match.
    if (isWrite && !wasRecorded) {
      return {
        kind: 'stale-read', statement: compact(sql),
        detail: 'this write was not in the recording, so it changes nothing',
      };
    }

    if (!isWrite && READ_STATEMENT.test(sql) && table && this.writtenTables.has(table)) {
      return {
        kind: 'stale-read', statement: compact(sql),
        detail: `reads "${table}" after this run wrote to it — the recorded rows are from before that write`,
      };
    }

    for (const { pattern, reason } of NON_DETERMINISTIC) {
      if (pattern.test(sql)) {
        return {
          kind: 'non-deterministic', statement: compact(sql),
          detail: `${reason}, so it replays the value recorded rather than a fresh one`,
        };
      }
    }
    return null;
  }

  all(): readonly DivergenceWarning[] {
    return this.warnings;
  }
}

function compact(sql: string): string {
  const single = sql.replace(/\s+/g, ' ').trim();
  return single.length > 90 ? `${single.slice(0, 87)}...` : single;
}
