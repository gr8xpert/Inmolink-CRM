CREATE TYPE "public"."support_message_author" AS ENUM('AGENCY', 'STAFF');--> statement-breakpoint
CREATE TYPE "public"."support_ticket_category" AS ENUM('ACCOUNT', 'BILLING', 'LISTINGS', 'IMPORTS', 'WEBSITE', 'INTEGRATIONS', 'BUG', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."support_ticket_priority" AS ENUM('LOW', 'NORMAL', 'HIGH', 'URGENT');--> statement-breakpoint
CREATE TYPE "public"."support_ticket_status" AS ENUM('OPEN', 'PENDING', 'RESOLVED');--> statement-breakpoint
CREATE TABLE "support_ticket_attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_ticket_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_kind" "support_message_author" NOT NULL,
	"author_user_id" uuid NOT NULL,
	"author_name" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_ticket_messages_body_len" CHECK (char_length("support_ticket_messages"."body") between 1 and 10000)
);
--> statement-breakpoint
CREATE TABLE "support_ticket_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"author_name" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_ticket_notes_body_len" CHECK (char_length("support_ticket_notes"."body") between 1 and 10000)
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"category" "support_ticket_category" NOT NULL,
	"priority" "support_ticket_priority" DEFAULT 'NORMAL' NOT NULL,
	"status" "support_ticket_status" DEFAULT 'OPEN' NOT NULL,
	"created_by" uuid NOT NULL,
	"assignee_user_id" uuid,
	"last_message_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_tickets_agency_id_uq" UNIQUE("agency_id","id"),
	CONSTRAINT "support_tickets_subject_len" CHECK (char_length("support_tickets"."subject") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "support_ticket_attachments" ADD CONSTRAINT "support_ticket_attachments_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_attachments" ADD CONSTRAINT "support_ticket_attachments_ticket_fk" FOREIGN KEY ("agency_id","ticket_id") REFERENCES "public"."support_tickets"("agency_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_ticket_fk" FOREIGN KEY ("agency_id","ticket_id") REFERENCES "public"."support_tickets"("agency_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_notes" ADD CONSTRAINT "support_ticket_notes_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_ticket_attachments_ticket_idx" ON "support_ticket_attachments" USING btree ("agency_id","ticket_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "support_ticket_attachments_key_uq" ON "support_ticket_attachments" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "support_ticket_messages_ticket_idx" ON "support_ticket_messages" USING btree ("agency_id","ticket_id","created_at","id");--> statement-breakpoint
CREATE INDEX "support_ticket_notes_ticket_idx" ON "support_ticket_notes" USING btree ("ticket_id","created_at","id");--> statement-breakpoint
CREATE INDEX "support_tickets_agency_idx" ON "support_tickets" USING btree ("agency_id","created_at","id");--> statement-breakpoint
CREATE INDEX "support_tickets_queue_idx" ON "support_tickets" USING btree ("status","last_message_at","id");