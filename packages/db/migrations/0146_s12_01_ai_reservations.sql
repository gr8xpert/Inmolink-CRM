ALTER TABLE "ai_jobs" ADD COLUMN "usage_month" date;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD COLUMN "reserved_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage_monthly" ADD COLUMN "reserved_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "ai_feedback_job_idx" ON "ai_feedback" USING btree ("ai_job_id");--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_reserved_ck" CHECK ("ai_jobs"."reserved_micro_usd" >= 0);--> statement-breakpoint
ALTER TABLE "ai_usage_monthly" ADD CONSTRAINT "ai_usage_monthly_reserved_ck" CHECK ("ai_usage_monthly"."reserved_micro_usd" >= 0);