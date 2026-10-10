import type { SQL } from 'drizzle-orm';

/** Any Drizzle transaction (or db) from `@inmolink/db` — kept structural so platform does not depend on db. */
export interface SqlExecutor {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}
