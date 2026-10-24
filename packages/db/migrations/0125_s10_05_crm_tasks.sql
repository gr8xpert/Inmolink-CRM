CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"due_at" timestamp with time zone,
	"due_sort_ms" timestamp with time zone GENERATED ALWAYS AS (coalesce(date_trunc('milliseconds', due_at, 'UTC'), to_timestamp(253402214400))) STORED NOT NULL,
	"remind" boolean DEFAULT true NOT NULL,
	"reminded_at" timestamp with time zone,
	"reminder_sent_for" timestamp with time zone,
	"assigned_user_id" uuid NOT NULL,
	"created_by" uuid,
	"contact_id" uuid,
	"lead_id" uuid,
	"listing_id" uuid,
	"completed_at" timestamp with time zone,
	"completed_by_user_id" uuid,
	"deleted_at" timestamp with time zone,
	"idempotency_hash" text,
	"request_hash" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_status_ck" CHECK ("tasks"."status" in ('OPEN', 'DONE')),
	CONSTRAINT "tasks_title_ck" CHECK (length("tasks"."title") between 1 and 200),
	CONSTRAINT "tasks_description_ck" CHECK ("tasks"."description" is null or length("tasks"."description") between 1 and 4000),
	CONSTRAINT "tasks_due_ms_ck" CHECK ("tasks"."due_at" is null or "tasks"."due_at" = date_trunc('milliseconds', "tasks"."due_at", 'UTC')),
	CONSTRAINT "tasks_idempotency_ck" CHECK (("tasks"."idempotency_hash" is null) = ("tasks"."request_hash" is null)),
	CONSTRAINT "tasks_completed_ck" CHECK (("tasks"."status" = 'DONE') = ("tasks"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "activities" DROP CONSTRAINT "activities_type_ck";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_contact_fk" FOREIGN KEY ("agency_id","contact_id") REFERENCES "public"."contacts"("agency_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_lead_fk" FOREIGN KEY ("agency_id","lead_id") REFERENCES "public"."leads"("agency_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("agency_id","assigned_user_id","status","due_sort_ms","id") WHERE "tasks"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "tasks_agency_idx" ON "tasks" USING btree ("agency_id","status","due_sort_ms","id") WHERE "tasks"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "tasks_contact_idx" ON "tasks" USING btree ("agency_id","contact_id","status","due_sort_ms","id") WHERE "tasks"."contact_id" is not null and "tasks"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "tasks_lead_idx" ON "tasks" USING btree ("agency_id","lead_id","status","due_sort_ms","id") WHERE "tasks"."lead_id" is not null and "tasks"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "tasks_listing_idx" ON "tasks" USING btree ("agency_id","listing_id","status","due_sort_ms","id") WHERE "tasks"."listing_id" is not null and "tasks"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "tasks_contact_all_idx" ON "tasks" USING btree ("agency_id","contact_id") WHERE "tasks"."contact_id" is not null;--> statement-breakpoint
CREATE INDEX "tasks_reminder_idx" ON "tasks" USING btree ("due_at","id") WHERE "tasks"."status" = 'OPEN' and "tasks"."remind" and "tasks"."reminded_at" is null and "tasks"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_idempotency_uq" ON "tasks" USING btree ("agency_id","idempotency_hash") WHERE "tasks"."idempotency_hash" is not null;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_type_ck" CHECK ("type" in ('CALL', 'EMAIL', 'MEETING', 'VIEWING', 'OTHER', 'NOTE_ADDED', 'CONTACT_MERGED', 'LEAD_CREATED', 'LEAD_UPDATED', 'LISTING_STATUS_CHANGED', 'STAGE_CHANGED', 'TASK_COMPLETED'));