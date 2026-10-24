CREATE TABLE "data_export_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"kind" text NOT NULL,
	"format" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"file_bytes" bigint,
	"error_code" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"idempotency_hash" text,
	"request_hash" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"file_deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_export_jobs_kind_ck" CHECK ("data_export_jobs"."kind" in ('CONTACTS', 'LEADS', 'LISTINGS', 'ACCOUNT')),
	CONSTRAINT "data_export_jobs_format_ck" CHECK ("data_export_jobs"."format" in ('csv', 'xlsx')),
	CONSTRAINT "data_export_jobs_status_ck" CHECK ("data_export_jobs"."status" in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'EXPIRED')),
	CONSTRAINT "data_export_jobs_error_ck" CHECK ("data_export_jobs"."error_code" is null or length("data_export_jobs"."error_code") <= 64),
	CONSTRAINT "data_export_jobs_idempotency_ck" CHECK (("data_export_jobs"."idempotency_hash" is null) = ("data_export_jobs"."request_hash" is null)),
	CONSTRAINT "data_export_jobs_counts_ck" CHECK (jsonb_typeof("data_export_jobs"."counts") = 'object')
);
--> statement-breakpoint
ALTER TABLE "data_export_jobs" ADD CONSTRAINT "data_export_jobs_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_export_jobs_agency_created_idx" ON "data_export_jobs" USING btree ("agency_id",date_trunc('milliseconds', "created_at", 'UTC'),"id");--> statement-breakpoint
CREATE UNIQUE INDEX "data_export_jobs_active_uq" ON "data_export_jobs" USING btree ("agency_id") WHERE "data_export_jobs"."status" in ('QUEUED', 'RUNNING');--> statement-breakpoint
CREATE UNIQUE INDEX "data_export_jobs_idempotency_uq" ON "data_export_jobs" USING btree ("agency_id","idempotency_hash") WHERE "data_export_jobs"."idempotency_hash" is not null;--> statement-breakpoint
CREATE INDEX "data_export_jobs_expiry_idx" ON "data_export_jobs" USING btree ("expires_at") WHERE "data_export_jobs"."file_deleted_at" is null and "data_export_jobs"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "data_export_jobs_stuck_idx" ON "data_export_jobs" USING btree ("created_at") WHERE "data_export_jobs"."status" in ('QUEUED', 'RUNNING');