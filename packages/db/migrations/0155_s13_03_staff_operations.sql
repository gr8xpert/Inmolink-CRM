CREATE TABLE "staff_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"target_agency_id" uuid,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'QUEUED' NOT NULL,
	"cursor" text,
	"done" integer DEFAULT 0 NOT NULL,
	"total" integer,
	"slices" integer DEFAULT 0 NOT NULL,
	"recoveries" integer DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"cancelled_by" uuid,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_operations_kind_ck" CHECK ("staff_operations"."kind" in ('REINDEX', 'REBUILD_READ_MODELS', 'REIMPORT', 'REPLAY_OUTBOX')),
	CONSTRAINT "staff_operations_state_ck" CHECK ("staff_operations"."state" in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
	CONSTRAINT "staff_operations_done_ck" CHECK ("staff_operations"."done" >= 0)
);
--> statement-breakpoint
ALTER TABLE "billing_plan_grants" ADD COLUMN "revoke_reason" text;--> statement-breakpoint
CREATE INDEX "staff_operations_created_idx" ON "staff_operations" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "staff_operations_active_idx" ON "staff_operations" USING btree ("updated_at") WHERE "staff_operations"."state" in ('QUEUED', 'RUNNING');--> statement-breakpoint
CREATE UNIQUE INDEX "staff_operations_active_uq" ON "staff_operations" USING btree ("kind",coalesce("target_agency_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "staff_operations"."state" in ('QUEUED', 'RUNNING');--> statement-breakpoint
CREATE INDEX "ai_usage_monthly_month_idx" ON "ai_usage_monthly" USING btree ("month");