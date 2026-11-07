CREATE TABLE "signature_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"signer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"otp_id" uuid,
	"otp_expires_at" timestamp with time zone,
	"ip" text,
	"user_agent" text,
	"signature_kind" text,
	"signature_text" text,
	"signature_png" text,
	"document_sha256" text,
	"consented" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signature_events_kind_ck" CHECK ("signature_events"."kind" in ('OTP_SENT', 'OTP_FAILED', 'SIGNED')),
	CONSTRAINT "signature_events_otp_sent_ck" CHECK (("signature_events"."kind" = 'OTP_SENT') = ("signature_events"."otp_expires_at" is not null)),
	CONSTRAINT "signature_events_otp_ck" CHECK (("signature_events"."kind" = 'OTP_SENT') = ("signature_events"."otp_id" is null)),
	CONSTRAINT "signature_events_ip_ck" CHECK ("signature_events"."ip" is null or char_length("signature_events"."ip") <= 64),
	CONSTRAINT "signature_events_ua_ck" CHECK ("signature_events"."user_agent" is null or char_length("signature_events"."user_agent") <= 512),
	CONSTRAINT "signature_events_signed_ck" CHECK (("signature_events"."kind" = 'SIGNED') = ("signature_events"."signature_kind" is not null and "signature_events"."signature_text" is not null and "signature_events"."document_sha256" is not null and "signature_events"."consented" is true)),
	CONSTRAINT "signature_events_signature_ck" CHECK ("signature_events"."signature_kind" is null or ("signature_events"."signature_kind" = 'TYPED' and "signature_events"."signature_png" is null) or ("signature_events"."signature_kind" = 'DRAWN' and "signature_events"."signature_png" is not null)),
	CONSTRAINT "signature_events_text_ck" CHECK ("signature_events"."signature_text" is null or char_length("signature_events"."signature_text") between 1 and 200),
	CONSTRAINT "signature_events_png_ck" CHECK ("signature_events"."signature_png" is null or (char_length("signature_events"."signature_png") <= 90000 and "signature_events"."signature_png" ~ '^[A-Za-z0-9+/]+={0,2}$')),
	CONSTRAINT "signature_events_sha256_ck" CHECK ("signature_events"."document_sha256" is null or "signature_events"."document_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "signature_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"ordered" boolean DEFAULT false NOT NULL,
	"document_sha256" text NOT NULL,
	"message" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"all_signed_at" timestamp with time zone,
	"signed_sha256" text,
	"signed_size_bytes" integer,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"idempotency_hash" text,
	"request_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signature_requests_status_ck" CHECK ("signature_requests"."status" in ('OPEN', 'SIGNED', 'COMPLETED', 'CANCELLED', 'FAILED')),
	CONSTRAINT "signature_requests_provider_ck" CHECK ("signature_requests"."provider" ~ '^[a-z][a-z0-9_-]{0,31}$'),
	CONSTRAINT "signature_requests_sha256_ck" CHECK ("signature_requests"."document_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "signature_requests_signed_sha256_ck" CHECK ("signature_requests"."signed_sha256" is null or "signature_requests"."signed_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "signature_requests_message_ck" CHECK ("signature_requests"."message" is null or char_length("signature_requests"."message") between 1 and 1000),
	CONSTRAINT "signature_requests_completed_ck" CHECK (("signature_requests"."status" = 'COMPLETED') = ("signature_requests"."signed_sha256" is not null and "signature_requests"."signed_size_bytes" is not null and "signature_requests"."completed_at" is not null)),
	CONSTRAINT "signature_requests_signed_ck" CHECK ("signature_requests"."status" not in ('SIGNED', 'COMPLETED') or "signature_requests"."all_signed_at" is not null),
	CONSTRAINT "signature_requests_cancelled_ck" CHECK (("signature_requests"."status" = 'CANCELLED') = ("signature_requests"."cancelled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "signature_signers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"role" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"locale" text NOT NULL,
	"invited_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"signature_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signature_signers_position_ck" CHECK ("signature_signers"."position" between 1 and 10),
	CONSTRAINT "signature_signers_role_ck" CHECK ("signature_signers"."role" ~ '^[a-zA-Z]{1,32}$'),
	CONSTRAINT "signature_signers_name_ck" CHECK (char_length("signature_signers"."name") between 1 and 200),
	CONSTRAINT "signature_signers_email_ck" CHECK (char_length("signature_signers"."email") between 3 and 254 and "signature_signers"."email" like '%@%'),
	CONSTRAINT "signature_signers_locale_ck" CHECK ("signature_signers"."locale" ~ '^[a-z]{2}$'),
	CONSTRAINT "signature_signers_signed_ck" CHECK (("signature_signers"."signed_at" is null) = ("signature_signers"."signature_event_id" is null))
);
--> statement-breakpoint
ALTER TABLE "signature_events" ADD CONSTRAINT "signature_events_signer_id_signature_signers_id_fk" FOREIGN KEY ("signer_id") REFERENCES "public"."signature_signers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_form_id_form_documents_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."form_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_signers" ADD CONSTRAINT "signature_signers_request_id_signature_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."signature_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signature_events_signer_idx" ON "signature_events" USING btree ("signer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "signature_events_signed_uq" ON "signature_events" USING btree ("signer_id") WHERE "signature_events"."kind" = 'SIGNED';--> statement-breakpoint
CREATE INDEX "signature_requests_form_idx" ON "signature_requests" USING btree ("agency_id","form_id","created_at","id");--> statement-breakpoint
CREATE INDEX "signature_requests_form_fk_idx" ON "signature_requests" USING btree ("form_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signature_requests_idempotency_uq" ON "signature_requests" USING btree ("agency_id","idempotency_hash") WHERE "signature_requests"."idempotency_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "signature_signers_request_position_uq" ON "signature_signers" USING btree ("request_id","position");