CREATE TABLE "activities" (
	"id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now(), 'UTC') NOT NULL,
	"type" text NOT NULL,
	"contact_id" uuid,
	"lead_id" uuid,
	"listing_id" uuid,
	"actor_user_id" uuid,
	"event_id" uuid,
	"idempotency_hash" text,
	"request_hash" text,
	"body" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activities_id_occurred_at_pk" PRIMARY KEY("id","occurred_at"),
	CONSTRAINT "activities_type_ck" CHECK ("activities"."type" in ('CALL', 'EMAIL', 'MEETING', 'VIEWING', 'OTHER', 'NOTE_ADDED', 'CONTACT_MERGED', 'LEAD_CREATED', 'LEAD_UPDATED', 'LISTING_STATUS_CHANGED')),
	CONSTRAINT "activities_subject_ck" CHECK ("activities"."contact_id" is not null or "activities"."lead_id" is not null or "activities"."listing_id" is not null),
	CONSTRAINT "activities_ms_ck" CHECK ("activities"."occurred_at" = date_trunc('milliseconds', "activities"."occurred_at", 'UTC')),
	CONSTRAINT "activities_body_ck" CHECK ("activities"."body" is null or length("activities"."body") between 1 and 4000),
	CONSTRAINT "activities_data_ck" CHECK (jsonb_typeof("activities"."data") = 'object' and octet_length("activities"."data"::text) <= 2048),
	CONSTRAINT "activities_idempotency_ck" CHECK (("activities"."idempotency_hash" is null) = ("activities"."request_hash" is null))
) PARTITION BY RANGE ("occurred_at"); -- S10-04: hand-added (drizzle has no PARTITION BY); partman setup at the end
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_contact_fk" FOREIGN KEY ("agency_id","contact_id") REFERENCES "public"."contacts"("agency_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_lead_fk" FOREIGN KEY ("agency_id","lead_id") REFERENCES "public"."leads"("agency_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_contact_idx" ON "activities" USING btree ("agency_id","contact_id","occurred_at","id") WHERE "activities"."contact_id" is not null;--> statement-breakpoint
CREATE INDEX "activities_lead_idx" ON "activities" USING btree ("agency_id","lead_id","occurred_at","id") WHERE "activities"."lead_id" is not null;--> statement-breakpoint
CREATE INDEX "activities_listing_idx" ON "activities" USING btree ("agency_id","listing_id","occurred_at","id") WHERE "activities"."listing_id" is not null;--> statement-breakpoint
CREATE INDEX "activities_agency_idx" ON "activities" USING btree ("agency_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "activities_agency_type_idx" ON "activities" USING btree ("agency_id","type","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "activities_event_uq" ON "activities" USING btree ("agency_id","event_id","occurred_at") WHERE "activities"."event_id" is not null;--> statement-breakpoint
CREATE INDEX "activities_idempotency_idx" ON "activities" USING btree ("agency_id","idempotency_hash") WHERE "activities"."idempotency_hash" is not null;--> statement-breakpoint
-- S10-04 activities: monthly partitions managed by pg_partman, like audit_logs (0024): premake 4 (the current month,
-- the 4 before it and the 4 ahead), `infinite_time_partitions` keeps creating months with no rows, no default partition
-- (a row outside every month fails loudly; a logged activity is at most 30 days old), partitions get no grants
-- (reached only through the parent). Maintenance: `app_partition_maintenance()`, hourly (`compliance.maintainPartitions`).
-- Retention NULL: the timeline is kept (a retention rule would be a PLAN decision).
SELECT partman.create_parent(
  p_parent_table := 'public.activities',
  p_control := 'occurred_at',
  p_interval := '1 month',
  p_premake := 4,
  p_default_table := false
);--> statement-breakpoint
UPDATE partman.part_config
   SET infinite_time_partitions = true, inherit_privileges = false, retention = NULL
 WHERE parent_table = 'public.activities';
