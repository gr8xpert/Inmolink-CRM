ALTER TABLE "search_index_queue" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "search_index_queue" ADD COLUMN "not_before" timestamp with time zone;--> statement-breakpoint
-- Insert/delete churn (S5-03): vacuum and analyze after 1 % / 2 % of rows changed, not the default 20 % / 10 %.
ALTER TABLE "search_index_queue" SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_analyze_scale_factor = 0.02);