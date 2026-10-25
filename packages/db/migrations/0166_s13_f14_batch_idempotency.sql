-- S13-F14: ai.batch claims a batch submit under the caller's idempotency key before calling the provider. The index is
-- partial on a new all-null column, so its build reads ai_jobs but indexes nothing (pre-launch, small).
ALTER TABLE "ai_jobs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_jobs_idempotency_uq" ON "ai_jobs" USING btree ("agency_id","idempotency_key") WHERE "ai_jobs"."idempotency_key" is not null;