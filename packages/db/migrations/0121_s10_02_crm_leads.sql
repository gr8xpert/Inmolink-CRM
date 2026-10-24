CREATE TABLE "lead_introductions" (
	"lead_id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"owner_agency_id" uuid NOT NULL,
	"source" text NOT NULL,
	"kind" text DEFAULT 'ENQUIRY' NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"hand_entered" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_ms" timestamp with time zone GENERATED ALWAYS AS (date_trunc('milliseconds', created_at, 'UTC')) STORED NOT NULL,
	CONSTRAINT "lead_introductions_owner_ck" CHECK ("lead_introductions"."owner_agency_id" <> "lead_introductions"."agency_id"),
	CONSTRAINT "lead_introductions_target_ck" CHECK ("lead_introductions"."target_kind" in ('LISTING', 'DEVELOPMENT', 'UNIT')),
	CONSTRAINT "lead_introductions_kind_ck" CHECK ("lead_introductions"."kind" in ('ENQUIRY', 'VIEWING_REQUEST')),
	CONSTRAINT "lead_introductions_source_ck" CHECK ("lead_introductions"."source" in ('WEBSITE', 'IFRAME', 'SELECTION', 'PORTFOLIO', 'PORTAL', 'MARKETPLACE', 'DEVELOPER_PORTAL', 'CHATBOT', 'WHATSAPP', 'MANUAL'))
);
--> statement-breakpoint
CREATE TABLE "lead_routing_settings" (
	"agency_id" uuid PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'UNASSIGNED' NOT NULL,
	"agent_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"last_assigned_user_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_routing_settings_mode_ck" CHECK ("lead_routing_settings"."mode" in ('UNASSIGNED', 'ROUND_ROBIN', 'OWNER_AGENT')),
	CONSTRAINT "lead_routing_settings_agents_ck" CHECK (cardinality("lead_routing_settings"."agent_user_ids") <= 200)
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"source" text NOT NULL,
	"kind" text DEFAULT 'ENQUIRY' NOT NULL,
	"status" text DEFAULT 'NEW' NOT NULL,
	"presenting_agency_id" uuid,
	"owner_agency_id" uuid,
	"target_kind" text,
	"target_id" uuid,
	"shown_ref" text,
	"inbound_lead_id" uuid,
	"message" text,
	"locale" text,
	"visitor_name" text,
	"visitor_email" text,
	"visitor_phone" text,
	"visitor_marketing_consent" boolean,
	"assigned_user_id" uuid,
	"assigned_at" timestamp with time zone,
	"first_responded_at" timestamp with time zone,
	"created_by" uuid,
	"idempotency_hash" text,
	"request_hash" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_ms" timestamp with time zone GENERATED ALWAYS AS (date_trunc('milliseconds', created_at, 'UTC')) STORED NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leads_agency_id_uq" UNIQUE("agency_id","id"),
	CONSTRAINT "leads_source_ck" CHECK ("leads"."source" in ('WEBSITE', 'IFRAME', 'SELECTION', 'PORTFOLIO', 'PORTAL', 'MARKETPLACE', 'DEVELOPER_PORTAL', 'CHATBOT', 'WHATSAPP', 'MANUAL')),
	CONSTRAINT "leads_kind_ck" CHECK ("leads"."kind" in ('ENQUIRY', 'VIEWING_REQUEST')),
	CONSTRAINT "leads_status_ck" CHECK ("leads"."status" in ('NEW', 'IN_PROGRESS', 'WON', 'LOST', 'SPAM')),
	CONSTRAINT "leads_target_ck" CHECK (("leads"."target_kind" is null and "leads"."target_id" is null and "leads"."shown_ref" is null and "leads"."owner_agency_id" is null)
        or ("leads"."target_kind" in ('LISTING', 'DEVELOPMENT', 'UNIT') and "leads"."target_id" is not null)),
	CONSTRAINT "leads_owner_ck" CHECK ("leads"."owner_agency_id" is null or "leads"."owner_agency_id" <> "leads"."agency_id"),
	CONSTRAINT "leads_sizes_ck" CHECK (coalesce(length("leads"."message"), 0) <= 4000 and coalesce(length("leads"."shown_ref"), 0) <= 64
        and coalesce(length("leads"."locale"), 0) <= 10 and coalesce(length("leads"."visitor_name"), 0) <= 120
        and coalesce(length("leads"."visitor_email"), 0) <= 254 and coalesce(length("leads"."visitor_phone"), 0) <= 32),
	CONSTRAINT "leads_assigned_ck" CHECK (("leads"."assigned_user_id" is null) = ("leads"."assigned_at" is null)),
	CONSTRAINT "leads_idempotency_ck" CHECK (("leads"."idempotency_hash" is null) = ("leads"."request_hash" is null))
);
--> statement-breakpoint
DROP INDEX "contacts_agency_created_idx";--> statement-breakpoint
DROP INDEX "contacts_agency_owner_created_idx";--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "created_ms" timestamp with time zone GENERATED ALWAYS AS (date_trunc('milliseconds', created_at, 'UTC')) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "lead_introductions" ADD CONSTRAINT "lead_introductions_lead_fk" FOREIGN KEY ("agency_id","lead_id") REFERENCES "public"."leads"("agency_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_routing_settings" ADD CONSTRAINT "lead_routing_settings_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_contact_fk" FOREIGN KEY ("agency_id","contact_id") REFERENCES "public"."contacts"("agency_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_introductions_owner_created_idx" ON "lead_introductions" USING btree ("owner_agency_id","created_ms","lead_id");--> statement-breakpoint
CREATE INDEX "lead_introductions_agency_idx" ON "lead_introductions" USING btree ("agency_id","lead_id");--> statement-breakpoint
CREATE INDEX "leads_agency_created_idx" ON "leads" USING btree ("agency_id","created_ms","id");--> statement-breakpoint
CREATE INDEX "leads_agency_assigned_created_idx" ON "leads" USING btree ("agency_id","assigned_user_id","created_ms","id");--> statement-breakpoint
CREATE INDEX "leads_agency_status_created_idx" ON "leads" USING btree ("agency_id","status","created_ms","id");--> statement-breakpoint
CREATE INDEX "leads_agency_source_created_idx" ON "leads" USING btree ("agency_id","source","created_ms","id");--> statement-breakpoint
CREATE INDEX "leads_contact_idx" ON "leads" USING btree ("agency_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_inbound_uq" ON "leads" USING btree ("agency_id","inbound_lead_id") WHERE "leads"."inbound_lead_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "leads_idempotency_uq" ON "leads" USING btree ("agency_id","idempotency_hash") WHERE "leads"."idempotency_hash" is not null;--> statement-breakpoint
CREATE INDEX "contacts_agency_created_idx" ON "contacts" USING btree ("agency_id","created_ms","id") WHERE "contacts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "contacts_agency_owner_created_idx" ON "contacts" USING btree ("agency_id","owner_user_id","created_ms","id") WHERE "contacts"."deleted_at" is null;