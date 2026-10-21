CREATE TYPE "public"."website_lead_kind" AS ENUM('ENQUIRY', 'VIEWING_REQUEST');--> statement-breakpoint
CREATE TYPE "public"."website_lead_verification" AS ENUM('TURNSTILE', 'SERVER_KEY');--> statement-breakpoint
CREATE TABLE "website_leads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"kind" "website_lead_kind" NOT NULL,
	"idempotency_hash" text,
	"request_hash" text NOT NULL,
	"verification" "website_lead_verification" NOT NULL,
	"target_kind" text,
	"target_id" uuid,
	"owner_agency_id" uuid,
	"shown_ref" text,
	"locale" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_hash" text NOT NULL,
	"key_tier" text NOT NULL,
	"phone" text,
	"message" text,
	"viewing_slots" jsonb,
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"page_url" text,
	"ack_sent_at" timestamp with time zone,
	"ack_skipped_reason" text,
	"agency_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_leads_key_tier_ck" CHECK ("website_leads"."key_tier" in ('STANDARD', 'HIGH')),
	CONSTRAINT "website_leads_ack_skipped_ck" CHECK ("website_leads"."ack_skipped_reason" is null or "website_leads"."ack_skipped_reason" in ('RECIPIENT_SITE_DAILY', 'RECIPIENT_DAILY', 'SITE_DAILY')),
	CONSTRAINT "website_leads_target_ck" CHECK (("website_leads"."target_kind" is null and "website_leads"."target_id" is null and "website_leads"."shown_ref" is null and "website_leads"."owner_agency_id" is null)
        or ("website_leads"."target_kind" in ('LISTING', 'UNIT') and "website_leads"."target_id" is not null and "website_leads"."shown_ref" is not null)),
	CONSTRAINT "website_leads_viewing_ck" CHECK ("website_leads"."kind" <> 'VIEWING_REQUEST' or ("website_leads"."target_id" is not null and "website_leads"."viewing_slots" is not null)),
	CONSTRAINT "website_leads_sizes_ck" CHECK (length("website_leads"."name") <= 120 and length("website_leads"."email") <= 254 and coalesce(length("website_leads"."phone"), 0) <= 32
        and coalesce(length("website_leads"."message"), 0) <= 4000 and coalesce(length("website_leads"."page_url"), 0) <= 2048
        and length("website_leads"."locale") <= 10 and coalesce(length("website_leads"."shown_ref"), 0) <= 64)
);
--> statement-breakpoint
ALTER TABLE "website_leads" ADD CONSTRAINT "website_leads_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_leads" ADD CONSTRAINT "website_leads_site_fk" FOREIGN KEY ("agency_id","site_id") REFERENCES "public"."website_sites"("agency_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "website_leads_agency_created_idx" ON "website_leads" USING btree ("agency_id","created_at","id");--> statement-breakpoint
CREATE INDEX "website_leads_site_idx" ON "website_leads" USING btree ("agency_id","site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "website_leads_idempotency_uq" ON "website_leads" USING btree ("site_id","idempotency_hash") WHERE "website_leads"."idempotency_hash" is not null;--> statement-breakpoint
CREATE INDEX "website_leads_idempotency_created_idx" ON "website_leads" USING btree ("created_at") WHERE "website_leads"."idempotency_hash" is not null;--> statement-breakpoint
CREATE INDEX "website_leads_recipient_ack_idx" ON "website_leads" USING btree ("email_hash","ack_sent_at") WHERE "website_leads"."ack_sent_at" is not null;--> statement-breakpoint
CREATE INDEX "website_leads_site_ack_idx" ON "website_leads" USING btree ("site_id","ack_sent_at") WHERE "website_leads"."ack_sent_at" is not null;