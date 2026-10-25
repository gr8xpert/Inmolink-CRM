CREATE TABLE "ai_feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid,
	"feature" text NOT NULL,
	"ai_job_id" uuid,
	"prompt_id" text,
	"prompt_version" integer,
	"rating" smallint NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_feedback_rating_ck" CHECK ("ai_feedback"."rating" in (-1, 1)),
	CONSTRAINT "ai_feedback_comment_ck" CHECK ("ai_feedback"."comment" is null or char_length("ai_feedback"."comment") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "ai_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"feature" text NOT NULL,
	"kind" text NOT NULL,
	"tier" text,
	"model" text NOT NULL,
	"prompt_id" text,
	"prompt_version" integer,
	"input_hash" char(64) NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"item_count" integer DEFAULT 1 NOT NULL,
	"provider_batch_id" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ai_jobs_kind_ck" CHECK ("ai_jobs"."kind" in ('GENERATE', 'STRUCTURED', 'BATCH', 'EMBED')),
	CONSTRAINT "ai_jobs_status_ck" CHECK ("ai_jobs"."status" in ('SUCCEEDED', 'FAILED', 'PENDING')),
	CONSTRAINT "ai_jobs_tier_ck" CHECK ("ai_jobs"."tier" is null or "ai_jobs"."tier" in ('FAST', 'SMART')),
	CONSTRAINT "ai_jobs_cost_ck" CHECK ("ai_jobs"."cost_micro_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ai_usage_monthly" (
	"agency_id" uuid NOT NULL,
	"month" date NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_monthly_agency_id_month_pk" PRIMARY KEY("agency_id","month"),
	CONSTRAINT "ai_usage_monthly_month_ck" CHECK (extract(day from "ai_usage_monthly"."month") = 1)
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"prompt_id" text NOT NULL,
	"version" integer NOT NULL,
	"content_hash" char(64) NOT NULL,
	"tier" text NOT NULL,
	"max_tokens" integer NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_versions_prompt_id_version_pk" PRIMARY KEY("prompt_id","version"),
	CONSTRAINT "prompt_versions_tier_ck" CHECK ("prompt_versions"."tier" in ('FAST', 'SMART'))
);
--> statement-breakpoint
ALTER TABLE "ai_feedback" ADD CONSTRAINT "ai_feedback_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_monthly" ADD CONSTRAINT "ai_usage_monthly_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_feedback_feature_created_idx" ON "ai_feedback" USING btree ("feature","created_at");--> statement-breakpoint
CREATE INDEX "ai_feedback_agency_created_idx" ON "ai_feedback" USING btree ("agency_id","created_at","id");--> statement-breakpoint
CREATE INDEX "ai_jobs_agency_created_idx" ON "ai_jobs" USING btree ("agency_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_jobs_batch_uq" ON "ai_jobs" USING btree ("agency_id","provider_batch_id") WHERE "ai_jobs"."provider_batch_id" is not null;