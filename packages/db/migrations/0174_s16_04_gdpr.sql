CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"granted" boolean NOT NULL,
	"source" text NOT NULL,
	"policy_version" text,
	"actor_user_id" uuid,
	"impersonated_by" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_records_purpose_ck" CHECK ("consent_records"."purpose" in ('MARKETING', 'PROCESSING')),
	CONSTRAINT "consent_records_source_ck" CHECK ("consent_records"."source" in ('DASHBOARD', 'WEBSITE', 'PORTAL', 'IMPORT', 'MERGE')),
	CONSTRAINT "consent_records_policy_version_ck" CHECK ("consent_records"."policy_version" is null or "consent_records"."policy_version" ~ '^[A-Za-z0-9._-]{1,32}$')
);
--> statement-breakpoint
CREATE TABLE "retention_settings" (
	"agency_id" uuid PRIMARY KEY NOT NULL,
	"inactive_contact_months" integer,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_settings_months_ck" CHECK ("retention_settings"."inactive_contact_months" is null or "retention_settings"."inactive_contact_months" between 6 and 240)
);
--> statement-breakpoint
ALTER TABLE "data_export_jobs" DROP CONSTRAINT "data_export_jobs_kind_ck";--> statement-breakpoint
ALTER TABLE "data_export_jobs" ADD COLUMN "subject_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_settings" ADD CONSTRAINT "retention_settings_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_records_contact_idx" ON "consent_records" USING btree ("agency_id","contact_id","recorded_at","id");--> statement-breakpoint
CREATE INDEX "retention_settings_active_idx" ON "retention_settings" USING btree ("agency_id") WHERE "retention_settings"."inactive_contact_months" is not null;--> statement-breakpoint
CREATE INDEX "data_export_jobs_subject_idx" ON "data_export_jobs" USING btree ("agency_id","subject_contact_id") WHERE "data_export_jobs"."subject_contact_id" is not null;--> statement-breakpoint
ALTER TABLE "data_export_jobs" ADD CONSTRAINT "data_export_jobs_subject_ck" CHECK (("data_export_jobs"."kind" = 'SUBJECT') = ("data_export_jobs"."subject_contact_id" is not null));--> statement-breakpoint
ALTER TABLE "data_export_jobs" ADD CONSTRAINT "data_export_jobs_kind_ck" CHECK ("data_export_jobs"."kind" in ('CONTACTS', 'LEADS', 'LISTINGS', 'ACCOUNT', 'SUBJECT'));