CREATE TYPE "public"."portal_channel_status" AS ENUM('AVAILABLE', 'PLANNED');--> statement-breakpoint
CREATE TYPE "public"."portal_override_action" AS ENUM('INCLUDE', 'EXCLUDE');--> statement-breakpoint
CREATE TYPE "public"."portal_selection_mode" AS ENUM('ALL_PUBLIC', 'TAGGED', 'MANUAL');--> statement-breakpoint
CREATE TABLE "agency_portal_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"channel_code" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"selection_mode" "portal_selection_mode" DEFAULT 'ALL_PUBLIC' NOT NULL,
	"selection_tag" text,
	"credentials_enc" text,
	"credential_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"token_hash" text NOT NULL,
	"token_hint" text NOT NULL,
	"token_created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agency_portal_connections_agency_id_uq" UNIQUE("agency_id","id"),
	CONSTRAINT "agency_portal_connections_name_ck" CHECK (char_length("agency_portal_connections"."name") between 1 and 80),
	CONSTRAINT "agency_portal_connections_tag_ck" CHECK (("agency_portal_connections"."selection_mode" = 'TAGGED') = ("agency_portal_connections"."selection_tag" is not null)
        and ("agency_portal_connections"."selection_tag" is null or (char_length("agency_portal_connections"."selection_tag") between 1 and 40 and "agency_portal_connections"."selection_tag" = lower(btrim("agency_portal_connections"."selection_tag"))))),
	CONSTRAINT "agency_portal_connections_hint_ck" CHECK (length("agency_portal_connections"."token_hint") = 4)
);
--> statement-breakpoint
CREATE TABLE "portal_channels" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" "portal_channel_status" DEFAULT 'AVAILABLE' NOT NULL,
	"credential_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_channels_code_ck" CHECK ("portal_channels"."code" ~ '^[a-z0-9-]{2,40}$')
);
--> statement-breakpoint
CREATE TABLE "portal_connection_properties" (
	"connection_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"action" "portal_override_action" NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_connection_properties_connection_id_property_id_pk" PRIMARY KEY("connection_id","property_id")
);
--> statement-breakpoint
ALTER TABLE "agency_portal_connections" ADD CONSTRAINT "agency_portal_connections_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_portal_connections" ADD CONSTRAINT "agency_portal_connections_channel_code_portal_channels_code_fk" FOREIGN KEY ("channel_code") REFERENCES "public"."portal_channels"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_connection_properties" ADD CONSTRAINT "portal_connection_properties_connection_fk" FOREIGN KEY ("agency_id","connection_id") REFERENCES "public"."agency_portal_connections"("agency_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_connection_properties" ADD CONSTRAINT "portal_connection_properties_property_fk" FOREIGN KEY ("property_id","agency_id") REFERENCES "public"."properties"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agency_portal_connections_agency_created_idx" ON "agency_portal_connections" USING btree ("agency_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "agency_portal_connections_token_uq" ON "agency_portal_connections" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "agency_portal_connections_name_uq" ON "agency_portal_connections" USING btree ("agency_id","channel_code",lower("name"));--> statement-breakpoint
CREATE INDEX "portal_connection_properties_action_idx" ON "portal_connection_properties" USING btree ("connection_id","action","property_id");--> statement-breakpoint
CREATE INDEX "portal_connection_properties_property_idx" ON "portal_connection_properties" USING btree ("property_id");--> statement-breakpoint
-- migration-check: allow built CONCURRENTLY by `pnpm db:migrate` before this migration (concurrent-indexes.ts): a no-op then
CREATE INDEX IF NOT EXISTS "properties_agency_export_idx" ON "properties" USING btree ("agency_id","id") WHERE "properties"."status" = 'ACTIVE' and "properties"."visibility" = 'PUBLIC' and "properties"."deleted_at" is null;