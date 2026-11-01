DROP INDEX "retention_settings_active_idx";--> statement-breakpoint
ALTER TABLE "retention_settings" ADD COLUMN "previous_months" integer;--> statement-breakpoint
ALTER TABLE "retention_settings" ADD COLUMN "effective_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "retention_settings" ADD CONSTRAINT "retention_settings_previous_ck" CHECK ("retention_settings"."previous_months" is null or "retention_settings"."previous_months" between 6 and 240);