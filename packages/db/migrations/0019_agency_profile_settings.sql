CREATE TYPE "public"."commission_type" AS ENUM('PCT', 'FIXED');--> statement-breakpoint
CREATE TABLE "agency_profiles" (
	"agency_id" uuid PRIMARY KEY NOT NULL,
	"logo_storage_key" text,
	"logo_content_type" text,
	"logo_size_bytes" integer,
	"logo_updated_at" timestamp with time zone,
	"primary_color" text,
	"accent_color" text,
	"contact_email" text,
	"contact_phone" text,
	"website_url" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agency_profiles_logo_ck" CHECK (("agency_profiles"."logo_storage_key" is null and "agency_profiles"."logo_content_type" is null and "agency_profiles"."logo_size_bytes" is null) or (starts_with("agency_profiles"."logo_storage_key", 'agency-logos/' || "agency_profiles"."agency_id"::text || '/') and "agency_profiles"."logo_content_type" in ('image/png', 'image/jpeg', 'image/webp') and "agency_profiles"."logo_size_bytes" > 0)),
	CONSTRAINT "agency_profiles_colors_ck" CHECK (("agency_profiles"."primary_color" is null or "agency_profiles"."primary_color" ~ '^#[0-9a-f]{6}$') and ("agency_profiles"."accent_color" is null or "agency_profiles"."accent_color" ~ '^#[0-9a-f]{6}$')),
	CONSTRAINT "agency_profiles_website_ck" CHECK ("agency_profiles"."website_url" is null or "agency_profiles"."website_url" ~ '^https?://')
);
--> statement-breakpoint
ALTER TABLE "agencies" ADD COLUMN "register_number" text;--> statement-breakpoint
ALTER TABLE "agency_settings" ADD COLUMN "default_commission_type" "commission_type";--> statement-breakpoint
ALTER TABLE "agency_settings" ADD COLUMN "default_commission_bp" integer;--> statement-breakpoint
ALTER TABLE "agency_settings" ADD COLUMN "default_commission_fixed_cents" bigint;--> statement-breakpoint
ALTER TABLE "agency_settings" ADD COLUMN "default_commission_currency" char(3);--> statement-breakpoint
ALTER TABLE "agency_settings" ADD COLUMN "default_commission_includes_vat" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agency_settings" ADD COLUMN "viewing_response_days" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "agency_settings" ADD COLUMN "white_label_reference_prefix" text;--> statement-breakpoint
ALTER TABLE "agency_settings" ADD COLUMN "white_label_show_powered_by" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agency_settings" ADD COLUMN "white_label_email_sender_name" text;--> statement-breakpoint
ALTER TABLE "agency_settings" ADD COLUMN "client_mode_pin_min_length" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "agency_settings" ADD COLUMN "client_mode_pin_max_attempts" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "agency_profiles" ADD CONSTRAINT "agency_profiles_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_settings" ADD CONSTRAINT "agency_settings_locales_ck" CHECK (cardinality("agency_settings"."enabled_locales") between 1 and 20);--> statement-breakpoint
ALTER TABLE "agency_settings" ADD CONSTRAINT "agency_settings_registration_days_ck" CHECK ("agency_settings"."registration_validity_days" between 1 and 1095);--> statement-breakpoint
ALTER TABLE "agency_settings" ADD CONSTRAINT "agency_settings_viewing_days_ck" CHECK ("agency_settings"."viewing_response_days" between 1 and 30);--> statement-breakpoint
ALTER TABLE "agency_settings" ADD CONSTRAINT "agency_settings_commission_ck" CHECK (("agency_settings"."default_commission_type" is null and "agency_settings"."default_commission_bp" is null and "agency_settings"."default_commission_fixed_cents" is null and "agency_settings"."default_commission_currency" is null) or ("agency_settings"."default_commission_type" = 'PCT' and "agency_settings"."default_commission_bp" between 1 and 10000 and "agency_settings"."default_commission_fixed_cents" is null and "agency_settings"."default_commission_currency" is null) or ("agency_settings"."default_commission_type" = 'FIXED' and "agency_settings"."default_commission_bp" is null and "agency_settings"."default_commission_fixed_cents" between 1 and 100000000000 and "agency_settings"."default_commission_currency" ~ '^[A-Z]{3}$'));--> statement-breakpoint
ALTER TABLE "agency_settings" ADD CONSTRAINT "agency_settings_reference_prefix_ck" CHECK ("agency_settings"."white_label_reference_prefix" is null or "agency_settings"."white_label_reference_prefix" ~ '^[A-Z0-9]{1,6}$');--> statement-breakpoint
ALTER TABLE "agency_settings" ADD CONSTRAINT "agency_settings_sender_name_ck" CHECK ("agency_settings"."white_label_email_sender_name" is null or char_length("agency_settings"."white_label_email_sender_name") between 2 and 80);--> statement-breakpoint
ALTER TABLE "agency_settings" ADD CONSTRAINT "agency_settings_pin_length_ck" CHECK ("agency_settings"."client_mode_pin_min_length" between 4 and 8);--> statement-breakpoint
ALTER TABLE "agency_settings" ADD CONSTRAINT "agency_settings_pin_attempts_ck" CHECK ("agency_settings"."client_mode_pin_max_attempts" between 3 and 10);--> statement-breakpoint
ALTER TABLE "agency_translations" ADD CONSTRAINT "agency_translations_length_ck" CHECK (("agency_translations"."tagline" is null or char_length("agency_translations"."tagline") <= 160) and ("agency_translations"."description" is null or char_length("agency_translations"."description") <= 5000));