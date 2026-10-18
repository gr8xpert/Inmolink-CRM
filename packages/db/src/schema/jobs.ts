import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Where a recurring job stopped (S5-F2): a bounded run (an orphan sweep's page cap) saves its last key here, and
 * the next run resumes after it — a sweep reaches objects past its first 100k keys. No row: start from the
 * beginning. Worker-only (`withSystem`), no tenant. SQL lives in `@inmolink/platform/queue` (`checkpoint.ts`);
 * keep column names in sync.
 */
export const jobCheckpoints = pgTable('job_checkpoints', {
  /** The job's name (`media.sweepOrphanDocuments`). */
  name: text('name').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
