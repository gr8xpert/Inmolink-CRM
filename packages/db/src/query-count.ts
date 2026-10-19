import type { Logger as DrizzleLogger } from 'drizzle-orm/logger';

/**
 * Query counting for tests and budgets (PATTERNS §20, `countQueries()`): every Drizzle instance in this
 * package logs through `queryLogger()`, which only counts while a `countQueries()` call is open, so it
 * costs nothing in production. `withSystemClient` (raw COPY streams) bypasses Drizzle and is not counted.
 */

interface Counter {
  all: number;
  statements: number;
  match?: RegExp;
}

const TX_CONTROL = /^\s*(begin|commit|rollback|savepoint|release)\b/i;
const counters = new Set<Counter>();

const logger: DrizzleLogger = {
  logQuery(query: string): void {
    if (counters.size === 0) return;
    const control = TX_CONTROL.test(query);
    for (const c of counters) {
      if (c.match && !c.match.test(query)) continue;
      c.all++;
      if (!control) c.statements++;
    }
  },
};

/** The shared Drizzle logger; pass it to every `drizzle()` call in this package. */
export function queryLogger(): DrizzleLogger {
  return logger;
}

export interface CountQueriesOptions {
  /**
   * Count `begin`, `commit` and `rollback` too — i.e. round trips to Postgres. By default only the
   * statements between them count, which is what the endpoint and hot-path budgets are written in.
   */
  includeTransactionControl?: boolean;
  /** Count only statements whose SQL matches (S6-F3: e.g. the writes of one table). */
  match?: RegExp;
}

/**
 * Runs `fn` and returns how many SQL statements this process sent through Drizzle meanwhile. Not for
 * concurrent use: two overlapping calls see each other's queries, so count one scenario at a time.
 */
export async function countQueries(fn: () => Promise<unknown>, options: CountQueriesOptions = {}): Promise<number> {
  const counter: Counter = { all: 0, statements: 0, match: options.match };
  counters.add(counter);
  try {
    await fn();
  } finally {
    counters.delete(counter);
  }
  return options.includeTransactionControl ? counter.all : counter.statements;
}
