CREATE TYPE "public"."verification_document_kind" AS ENUM('TAX_ID', 'BUSINESS_PROOF', 'REGISTER', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."verification_request_status" AS ENUM('SUBMITTED', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('SUPER_ADMIN', 'STAFF_SUPPORT', 'STAFF_DATA_OPS');--> statement-breakpoint
CREATE TABLE "agency_verification_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"request_id" uuid,
	"kind" "verification_document_kind" NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agency_verification_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"status" "verification_request_status" DEFAULT 'SUBMITTED' NOT NULL,
	"details_version" integer NOT NULL,
	"submitted_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"reviewed_version" integer,
	"reviewer_user_id" uuid,
	"decision_reason" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_users" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"role" "staff_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agency_verification_documents" ADD CONSTRAINT "agency_verification_documents_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_verification_documents" ADD CONSTRAINT "agency_verification_documents_request_id_agency_verification_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."agency_verification_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_verification_requests" ADD CONSTRAINT "agency_verification_requests_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agency_verification_documents_agency_idx" ON "agency_verification_documents" USING btree ("agency_id","created_at","id");--> statement-breakpoint
CREATE INDEX "agency_verification_documents_request_idx" ON "agency_verification_documents" USING btree ("request_id") WHERE request_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "agency_verification_documents_key_uq" ON "agency_verification_documents" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "agency_verification_requests_queue_idx" ON "agency_verification_requests" USING btree ("status","submitted_at","id");--> statement-breakpoint
CREATE INDEX "agency_verification_requests_agency_idx" ON "agency_verification_requests" USING btree ("agency_id","submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agency_verification_requests_open_uq" ON "agency_verification_requests" USING btree ("agency_id") WHERE status = 'SUBMITTED';