CREATE TYPE "public"."agency_kind" AS ENUM('AGENCY', 'DEVELOPER', 'PARTNER');--> statement-breakpoint
CREATE TYPE "public"."agency_status" AS ENUM('PENDING', 'VERIFIED', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('AGENCY_ADMIN', 'AGENT', 'DEVELOPER_ADMIN', 'DEVELOPER_AGENT', 'PARTNER');--> statement-breakpoint
CREATE TABLE "agencies" (
	"agency_id" uuid PRIMARY KEY NOT NULL,
	"kind" "agency_kind" NOT NULL,
	"status" "agency_status" DEFAULT 'PENDING' NOT NULL,
	"name" text NOT NULL,
	"tax_id" text,
	"address_line" text,
	"city" text,
	"postal_code" text,
	"region" text,
	"languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"onboarded_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agency_settings" (
	"agency_id" uuid PRIMARY KEY NOT NULL,
	"enabled_locales" text[] NOT NULL,
	"registration_validity_days" integer DEFAULT 180 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agency_translations" (
	"agency_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"tagline" text,
	"description" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agency_translations_agency_id_locale_pk" PRIMARY KEY("agency_id","locale")
);
--> statement-breakpoint
CREATE TABLE "agency_members" (
	"agency_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agency_members_agency_id_user_id_pk" PRIMARY KEY("agency_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "agency_settings" ADD CONSTRAINT "agency_settings_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_translations" ADD CONSTRAINT "agency_translations_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_members" ADD CONSTRAINT "agency_members_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_members" ADD CONSTRAINT "agency_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agencies_tax_id_idx" ON "agencies" USING btree ("tax_id") WHERE tax_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "agency_members_user_uq" ON "agency_members" USING btree ("user_id");