-- S13-F9: retention indexes for the S12 growth tables (each daily prune and the per-search alert cap index-backed).
-- Built here while the tables are small (pre-launch); ai_jobs and saved_search_alerts grow with usage, so a later
-- rebuild of those two runs CONCURRENTLY (CONCURRENT_INDEXES, declaredBy this migration).
CREATE INDEX IF NOT EXISTS "ai_jobs_prune_idx" ON "ai_jobs" USING btree ("created_at") WHERE "ai_jobs"."status" <> 'PENDING';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saved_search_alerts_search_created_idx" ON "saved_search_alerts" USING btree ("saved_search_id","created_at");--> statement-breakpoint
CREATE INDEX "selections_ended_idx" ON "selections" USING btree (least("revoked_at", "expires_at"),"id") WHERE "selections"."revoked_at" is not null or "selections"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "social_posts_finished_idx" ON "social_posts" USING btree ("updated_at") WHERE "social_posts"."status" in ('PUBLISHED', 'FAILED');