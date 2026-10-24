CREATE TABLE "contact_emails" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"email" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_emails_normalized_ck" CHECK ("contact_emails"."email" = lower(btrim("contact_emails"."email")) and length("contact_emails"."email") <= 254)
);
--> statement-breakpoint
CREATE TABLE "contact_facets" (
	"agency_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"facet" text NOT NULL,
	CONSTRAINT "contact_facets_contact_id_facet_pk" PRIMARY KEY("contact_id","facet"),
	CONSTRAINT "contact_facets_facet_ck" CHECK ("contact_facets"."facet" ~ '^(tag|type):' and length("contact_facets"."facet") <= 60)
);
--> statement-breakpoint
CREATE TABLE "contact_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"file_kind" text NOT NULL,
	"file_bytes" integer NOT NULL,
	"status" text DEFAULT 'UPLOADED' NOT NULL,
	"headers" text[] DEFAULT '{}'::text[] NOT NULL,
	"mapping" jsonb,
	"on_duplicate" text DEFAULT 'SKIP' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"merged_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"invalid_count" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"file_deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_imports_status_ck" CHECK ("contact_imports"."status" in ('UPLOADED', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'EXPIRED')),
	CONSTRAINT "contact_imports_kind_ck" CHECK ("contact_imports"."file_kind" in ('csv', 'xlsx')),
	CONSTRAINT "contact_imports_duplicate_ck" CHECK ("contact_imports"."on_duplicate" in ('SKIP', 'MERGE')),
	CONSTRAINT "contact_imports_error_ck" CHECK ("contact_imports"."error_code" is null or length("contact_imports"."error_code") <= 64)
);
--> statement-breakpoint
CREATE TABLE "contact_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"author_user_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_notes_body_ck" CHECK (length("contact_notes"."body") between 1 and 10000)
);
--> statement-breakpoint
CREATE TABLE "contact_phones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_phones_e164_ck" CHECK ("contact_phones"."phone" ~ '^\+[1-9][0-9]{6,14}$')
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"types" text[] DEFAULT '{}'::text[] NOT NULL,
	"first_name" text,
	"last_name" text,
	"primary_email" text,
	"primary_phone" text,
	"language" text,
	"source" text DEFAULT 'MANUAL' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"consent_marketing" boolean DEFAULT false NOT NULL,
	"consent_marketing_at" timestamp with time zone,
	"consent_processing" boolean DEFAULT false NOT NULL,
	"consent_processing_at" timestamp with time zone,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"merged_into_id" uuid,
	"idempotency_hash" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "contacts_types_ck" CHECK ("contacts"."types" <@ array['BUYER', 'SELLER', 'TENANT', 'LANDLORD']::text[]),
	CONSTRAINT "contacts_source_ck" CHECK ("contacts"."source" in ('MANUAL', 'WEBSITE', 'PORTAL', 'IMPORT', 'REFERRAL', 'WALK_IN', 'PHONE', 'SOCIAL', 'OTHER')),
	CONSTRAINT "contacts_merged_ck" CHECK ("contacts"."merged_into_id" is null or "contacts"."deleted_at" is not null)
);
--> statement-breakpoint
-- the composite FKs below need the (agency_id, id) unique index first
CREATE UNIQUE INDEX "contacts_agency_id_uq" ON "contacts" USING btree ("agency_id","id");--> statement-breakpoint
ALTER TABLE "contact_emails" ADD CONSTRAINT "contact_emails_contact_fk" FOREIGN KEY ("agency_id","contact_id") REFERENCES "public"."contacts"("agency_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_facets" ADD CONSTRAINT "contact_facets_contact_fk" FOREIGN KEY ("agency_id","contact_id") REFERENCES "public"."contacts"("agency_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_imports" ADD CONSTRAINT "contact_imports_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_contact_fk" FOREIGN KEY ("agency_id","contact_id") REFERENCES "public"."contacts"("agency_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_phones" ADD CONSTRAINT "contact_phones_contact_fk" FOREIGN KEY ("agency_id","contact_id") REFERENCES "public"."contacts"("agency_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_merged_into_fk" FOREIGN KEY ("agency_id","merged_into_id") REFERENCES "public"."contacts"("agency_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_emails_agency_email_uq" ON "contact_emails" USING btree ("agency_id","email");--> statement-breakpoint
CREATE INDEX "contact_emails_contact_idx" ON "contact_emails" USING btree ("agency_id","contact_id","position");--> statement-breakpoint
CREATE INDEX "contact_facets_agency_facet_idx" ON "contact_facets" USING btree ("agency_id","facet","contact_id");--> statement-breakpoint
CREATE INDEX "contact_imports_agency_created_idx" ON "contact_imports" USING btree ("agency_id",date_trunc('milliseconds', "created_at", 'UTC'),"id");--> statement-breakpoint
CREATE INDEX "contact_imports_file_idx" ON "contact_imports" USING btree ("created_at") WHERE "contact_imports"."file_deleted_at" is null;--> statement-breakpoint
CREATE INDEX "contact_notes_contact_created_idx" ON "contact_notes" USING btree ("agency_id","contact_id",date_trunc('milliseconds', "created_at", 'UTC'),"id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_phones_agency_phone_uq" ON "contact_phones" USING btree ("agency_id","phone");--> statement-breakpoint
CREATE INDEX "contact_phones_contact_idx" ON "contact_phones" USING btree ("agency_id","contact_id","position");--> statement-breakpoint
CREATE INDEX "contacts_agency_created_idx" ON "contacts" USING btree ("agency_id",date_trunc('milliseconds', "created_at", 'UTC'),"id") WHERE "contacts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "contacts_agency_owner_created_idx" ON "contacts" USING btree ("agency_id","owner_user_id",date_trunc('milliseconds', "created_at", 'UTC'),"id") WHERE "contacts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "contacts_merged_into_idx" ON "contacts" USING btree ("agency_id","merged_into_id") WHERE "contacts"."merged_into_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_idempotency_uq" ON "contacts" USING btree ("agency_id","idempotency_hash") WHERE "contacts"."idempotency_hash" is not null;
