CREATE TABLE "notification_preferences" (
	"agency_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"in_app" boolean DEFAULT true NOT NULL,
	"email" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_agency_id_user_id_type_pk" PRIMARY KEY("agency_id","user_id","type"),
	CONSTRAINT "notification_preferences_type_ck" CHECK ("notification_preferences"."type" ~ '^[A-Z][A-Z0-9_]{1,47}$')
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now(), 'UTC') NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_user_id" uuid,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"link" text,
	"source_key" text,
	"in_app" boolean DEFAULT true NOT NULL,
	"email_pending" boolean DEFAULT false NOT NULL,
	"digested_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	CONSTRAINT "notifications_id_created_at_pk" PRIMARY KEY("id","created_at"),
	CONSTRAINT "notifications_ms_ck" CHECK ("notifications"."created_at" = date_trunc('milliseconds', "notifications"."created_at", 'UTC')),
	CONSTRAINT "notifications_type_ck" CHECK ("notifications"."type" ~ '^[A-Z][A-Z0-9_]{1,47}$'),
	CONSTRAINT "notifications_params_ck" CHECK (jsonb_typeof("notifications"."params") = 'object' and octet_length("notifications"."params"::text) <= 2048),
	CONSTRAINT "notifications_link_ck" CHECK ("notifications"."link" is null or (left("notifications"."link", 1) = '/' and substr("notifications"."link", 2, 1) not in ('', '/', chr(92)) and length("notifications"."link") <= 300)),
	CONSTRAINT "notifications_source_ck" CHECK ("notifications"."source_key" is null or length("notifications"."source_key") between 1 and 200)
) PARTITION BY RANGE ("created_at"); -- S11-04: hand-added (drizzle has no PARTITION BY); partman setup at the end
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_feed_idx" ON "notifications" USING btree ("agency_id","user_id","created_at","id") WHERE "notifications"."in_app";--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("agency_id","user_id","created_at","id") WHERE "notifications"."in_app" and "notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "notifications_digest_idx" ON "notifications" USING btree ("agency_id","user_id","created_at","id") WHERE "notifications"."email_pending";--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_source_uq" ON "notifications" USING btree ("agency_id","user_id","source_key","created_at") WHERE "notifications"."source_key" is not null;--> statement-breakpoint
-- S11-04 notifications: monthly partitions managed by pg_partman, like activities (0123): premake 4,
-- `infinite_time_partitions` keeps creating months with no rows, no default partition (a row outside every month fails
-- loudly), partitions get no grants (reached only through the parent). Maintenance: `app_partition_maintenance()`,
-- hourly (`compliance.maintainPartitions`). Retention 12 months, dropped: notifications are ephemeral (STATUS Decisions).
SELECT partman.create_parent(
  p_parent_table := 'public.notifications',
  p_control := 'created_at',
  p_interval := '1 month',
  p_premake := 4,
  p_default_table := false
);--> statement-breakpoint
UPDATE partman.part_config
   SET infinite_time_partitions = true, inherit_privileges = false, retention = '12 months', retention_keep_table = false
 WHERE parent_table = 'public.notifications';
