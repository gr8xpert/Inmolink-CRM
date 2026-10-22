ALTER TABLE "feed_runs" ADD COLUMN "error_detail" text;--> statement-breakpoint
ALTER TABLE "feed_runs" ADD COLUMN "checkpoint" jsonb;--> statement-breakpoint
-- NOT VALID: every existing row has error_detail null (it satisfies the check), and the ALTER then takes its lock only
-- briefly. New and updated rows are checked. A later `VALIDATE CONSTRAINT` (S7-F13) scans under SHARE UPDATE EXCLUSIVE,
-- which does not block reads or writes.
ALTER TABLE "feed_runs" ADD CONSTRAINT "feed_runs_error_detail_ck" CHECK (char_length("feed_runs"."error_detail") <= 500) NOT VALID;
