ALTER TABLE "feed_connections" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feed_connections" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "feed_connections" ADD COLUMN "pause_details" jsonb;--> statement-breakpoint
ALTER TABLE "feed_connections" ADD COLUMN "paused_run_id" uuid;--> statement-breakpoint
ALTER TABLE "feed_connections" ADD COLUMN "accept_anomaly_once" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "feed_connections" ADD COLUMN "content_changed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "feed_connections_paused_idx" ON "feed_connections" USING btree ("paused_at") WHERE "feed_connections"."paused_at" is not null;--> statement-breakpoint
CREATE INDEX "feed_runs_finished_at_idx" ON "feed_runs" USING btree ("finished_at") WHERE "feed_runs"."finished_at" is not null;--> statement-breakpoint
ALTER TABLE "feed_connections" ADD CONSTRAINT "feed_connections_pause_ck" CHECK (("feed_connections"."paused_at" is null) = ("feed_connections"."pause_reason" is null)
        and ("feed_connections"."pause_reason" is null or "feed_connections"."pause_reason" in ('VOLUME_SPIKE', 'MASS_WITHDRAWAL')));