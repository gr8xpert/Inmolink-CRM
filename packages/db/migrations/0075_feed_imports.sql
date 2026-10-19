CREATE TYPE "public"."feed_run_state" AS ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."feed_run_trigger" AS ENUM('SCHEDULE', 'MANUAL');--> statement-breakpoint
CREATE TABLE "feed_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"name" text NOT NULL,
	"connector" text NOT NULL,
	"url" text NOT NULL,
	"credentials_enc" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mapping_profile_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"schedule_minutes" integer,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_run_state" "feed_run_state",
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_connections_id_agency_uq" UNIQUE("id","agency_id"),
	CONSTRAINT "feed_connections_name_ck" CHECK (char_length("feed_connections"."name") between 1 and 120),
	CONSTRAINT "feed_connections_connector_ck" CHECK ("feed_connections"."connector" ~ '^[a-z][a-z0-9-]{1,31}$'),
	CONSTRAINT "feed_connections_url_ck" CHECK ("feed_connections"."url" ~ '^https?://' and char_length("feed_connections"."url") <= 2048),
	CONSTRAINT "feed_connections_schedule_ck" CHECK ("feed_connections"."schedule_minutes" is null or "feed_connections"."schedule_minutes" between 15 and 10080)
);
--> statement-breakpoint
CREATE TABLE "feed_item_errors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"item_ref" text,
	"code" text NOT NULL,
	"field" text,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_item_errors_ref_ck" CHECK (char_length("feed_item_errors"."item_ref") <= 200),
	CONSTRAINT "feed_item_errors_code_ck" CHECK ("feed_item_errors"."code" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "feed_item_errors_field_ck" CHECK (char_length("feed_item_errors"."field") <= 120),
	CONSTRAINT "feed_item_errors_message_ck" CHECK (char_length("feed_item_errors"."message") <= 500)
);
--> statement-breakpoint
CREATE TABLE "feed_mapping_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"name" text NOT NULL,
	"connector" text NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_mapping_profiles_id_agency_uq" UNIQUE("id","agency_id"),
	CONSTRAINT "feed_mapping_profiles_name_ck" CHECK (char_length("feed_mapping_profiles"."name") between 1 and 120),
	CONSTRAINT "feed_mapping_profiles_connector_ck" CHECK ("feed_mapping_profiles"."connector" ~ '^[a-z][a-z0-9-]{1,31}$')
);
--> statement-breakpoint
CREATE TABLE "feed_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"trigger" "feed_run_trigger" NOT NULL,
	"requested_by_user_id" uuid,
	"state" "feed_run_state" DEFAULT 'QUEUED' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"items_total" integer DEFAULT 0 NOT NULL,
	"items_valid" integer DEFAULT 0 NOT NULL,
	"items_failed" integer DEFAULT 0 NOT NULL,
	"items_created" integer DEFAULT 0 NOT NULL,
	"items_updated" integer DEFAULT 0 NOT NULL,
	"items_unchanged" integer DEFAULT 0 NOT NULL,
	"errors_logged" integer DEFAULT 0 NOT NULL,
	"bytes_read" bigint DEFAULT 0 NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_runs_id_agency_uq" UNIQUE("id","agency_id"),
	CONSTRAINT "feed_runs_counts_ck" CHECK ("feed_runs"."items_valid" + "feed_runs"."items_failed" = "feed_runs"."items_total"
        and "feed_runs"."items_created" + "feed_runs"."items_updated" + "feed_runs"."items_unchanged" <= "feed_runs"."items_valid"
        and "feed_runs"."errors_logged" <= "feed_runs"."items_failed"),
	CONSTRAINT "feed_runs_lease_ck" CHECK (("feed_runs"."state" = 'RUNNING') = ("feed_runs"."lease_token" is not null))
);
--> statement-breakpoint
ALTER TABLE "feed_connections" ADD CONSTRAINT "feed_connections_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_connections" ADD CONSTRAINT "feed_connections_mapping_profile_fk" FOREIGN KEY ("mapping_profile_id","agency_id") REFERENCES "public"."feed_mapping_profiles"("id","agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_item_errors" ADD CONSTRAINT "feed_item_errors_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_item_errors" ADD CONSTRAINT "feed_item_errors_run_fk" FOREIGN KEY ("run_id","agency_id") REFERENCES "public"."feed_runs"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_mapping_profiles" ADD CONSTRAINT "feed_mapping_profiles_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_runs" ADD CONSTRAINT "feed_runs_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_runs" ADD CONSTRAINT "feed_runs_connection_fk" FOREIGN KEY ("connection_id","agency_id") REFERENCES "public"."feed_connections"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feed_connections_agency_created_idx" ON "feed_connections" USING btree ("agency_id",date_trunc('milliseconds', "created_at", 'UTC'),"id");--> statement-breakpoint
CREATE INDEX "feed_connections_due_idx" ON "feed_connections" USING btree ("next_run_at") WHERE "feed_connections"."enabled" and "feed_connections"."next_run_at" is not null;--> statement-breakpoint
CREATE INDEX "feed_connections_mapping_profile_idx" ON "feed_connections" USING btree ("mapping_profile_id") WHERE "feed_connections"."mapping_profile_id" is not null;--> statement-breakpoint
CREATE INDEX "feed_item_errors_run_position_idx" ON "feed_item_errors" USING btree ("run_id","position","id");--> statement-breakpoint
CREATE INDEX "feed_mapping_profiles_agency_created_idx" ON "feed_mapping_profiles" USING btree ("agency_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_runs_connection_active_uq" ON "feed_runs" USING btree ("connection_id") WHERE "feed_runs"."state" in ('QUEUED', 'RUNNING');--> statement-breakpoint
CREATE INDEX "feed_runs_connection_created_idx" ON "feed_runs" USING btree ("connection_id",date_trunc('milliseconds', "created_at", 'UTC'),"id");--> statement-breakpoint
CREATE INDEX "feed_runs_agency_created_idx" ON "feed_runs" USING btree ("agency_id","created_at");--> statement-breakpoint
CREATE INDEX "feed_runs_finished_created_idx" ON "feed_runs" USING btree ("created_at") WHERE "feed_runs"."state" in ('SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE INDEX "feed_runs_active_idx" ON "feed_runs" USING btree ("state","lease_until","created_at") WHERE "feed_runs"."state" in ('QUEUED', 'RUNNING');