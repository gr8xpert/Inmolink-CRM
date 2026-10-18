import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../sql';

/**
 * A recurring job's resume point (S5-F2, table `job_checkpoints`): a run cut short by its bound saves where it
 * stopped, the next run continues after it; a run that reached the end clears it (the next one wraps to the
 * start). Pass a `withSystem` transaction.
 */
export async function readCheckpoint(db: SqlExecutor, name: string): Promise<string | undefined> {
  const { rows } = await db.execute(sql`select value from job_checkpoints where name = ${name}`);
  return (rows[0]?.value as string | undefined) ?? undefined;
}

/** Saves `value` as `name`'s resume point, or clears it (`null`). */
export async function writeCheckpoint(db: SqlExecutor, name: string, value: string | null): Promise<void> {
  await db.execute(
    value === null
      ? sql`delete from job_checkpoints where name = ${name}`
      : sql`insert into job_checkpoints (name, value) values (${name}, ${value})
            on conflict (name) do update set value = excluded.value, updated_at = now()`,
  );
}
