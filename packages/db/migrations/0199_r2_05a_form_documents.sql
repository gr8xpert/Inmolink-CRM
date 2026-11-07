CREATE TABLE "form_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"template" text NOT NULL,
	"locale" text NOT NULL,
	"template_version" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"listing_id" uuid,
	"contact_id" uuid,
	"deal_id" uuid,
	"label" text NOT NULL,
	"data" jsonb NOT NULL,
	"sha256" text,
	"size_bytes" integer,
	"rendered_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"idempotency_hash" text,
	"request_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "form_documents_template_ck" CHECK ("form_documents"."template" in ('LISTING_AGREEMENT', 'RESERVATION', 'VIEWING_SHEET', 'OFFER', 'COLLABORATION_AGREEMENT')),
	CONSTRAINT "form_documents_status_ck" CHECK ("form_documents"."status" in ('PENDING', 'READY', 'FAILED')),
	CONSTRAINT "form_documents_locale_ck" CHECK ("form_documents"."locale" ~ '^[a-z]{2}(-[A-Z]{2})?$'),
	CONSTRAINT "form_documents_label_ck" CHECK (char_length("form_documents"."label") between 1 and 300),
	CONSTRAINT "form_documents_data_ck" CHECK (jsonb_typeof("form_documents"."data") = 'object' and pg_column_size("form_documents"."data") <= 65536),
	CONSTRAINT "form_documents_sha256_ck" CHECK ("form_documents"."sha256" is null or "form_documents"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "form_documents_ready_ck" CHECK (("form_documents"."status" = 'READY') = ("form_documents"."sha256" is not null and "form_documents"."size_bytes" is not null and "form_documents"."rendered_at" is not null))
);
--> statement-breakpoint
CREATE INDEX "form_documents_list_idx" ON "form_documents" USING btree ("agency_id","created_at","id");--> statement-breakpoint
CREATE INDEX "form_documents_contact_idx" ON "form_documents" USING btree ("agency_id","contact_id","created_at","id") WHERE "form_documents"."contact_id" is not null;--> statement-breakpoint
CREATE INDEX "form_documents_listing_idx" ON "form_documents" USING btree ("agency_id","listing_id","created_at","id") WHERE "form_documents"."listing_id" is not null;--> statement-breakpoint
CREATE INDEX "form_documents_deal_idx" ON "form_documents" USING btree ("agency_id","deal_id","created_at","id") WHERE "form_documents"."deal_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "form_documents_idempotency_uq" ON "form_documents" USING btree ("agency_id","idempotency_hash") WHERE "form_documents"."idempotency_hash" is not null;