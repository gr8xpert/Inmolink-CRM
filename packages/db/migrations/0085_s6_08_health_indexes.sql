-- S6-08 review: the import health dashboard reads the window index-only, and the latest failures off their own index.
DROP INDEX IF EXISTS "feed_runs_finished_at_idx";--> statement-breakpoint
-- migration-check: allow pre-launch: feed_runs is small until feeds run in production (S6); later rebuilds are
-- concurrent (concurrent-indexes.ts, declaredBy)
CREATE INDEX IF NOT EXISTS "feed_runs_failed_finished_idx" ON "feed_runs" USING btree ("finished_at") WHERE "feed_runs"."state" = 'FAILED';--> statement-breakpoint
-- migration-check: allow pre-launch: feed_runs is small until feeds run in production (S6); later rebuilds are
-- concurrent (concurrent-indexes.ts, declaredBy)
CREATE INDEX IF NOT EXISTS "feed_runs_finished_at_idx" ON "feed_runs" USING btree ("finished_at","state","error_code","created_at","started_at") WHERE "feed_runs"."finished_at" is not null;
