ALTER TABLE "agency_settings" DROP CONSTRAINT "agency_settings_commission_ck";--> statement-breakpoint
-- S1-06-F1: agencies that never set a default commission get the PLAN §3 #7 default (5 %). One row per
-- agency (≤ 5,000 at the ceiling): a single update is short. The table FORCEs row level security
-- (pnpm db:rls), which hides its rows from the owner running this migration: lift it for the backfill,
-- inside the migration transaction, and restore it.
DO $$
DECLARE settings_forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO settings_forced FROM pg_class WHERE oid = 'public.agency_settings'::regclass;
  ALTER TABLE "agency_settings" NO FORCE ROW LEVEL SECURITY;
  UPDATE "agency_settings" SET "default_commission_type" = 'PCT', "default_commission_bp" = 500 WHERE "default_commission_type" IS NULL;
  IF settings_forced THEN ALTER TABLE "agency_settings" FORCE ROW LEVEL SECURITY; END IF;
END $$;--> statement-breakpoint
ALTER TABLE "agency_settings" ALTER COLUMN "default_commission_type" SET DEFAULT 'PCT';--> statement-breakpoint
ALTER TABLE "agency_settings" ALTER COLUMN "default_commission_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agency_settings" ALTER COLUMN "default_commission_bp" SET DEFAULT 500;--> statement-breakpoint
ALTER TABLE "agency_settings" ADD COLUMN "default_split_bp" integer DEFAULT 5000 NOT NULL;--> statement-breakpoint
ALTER TABLE "agency_settings" ADD CONSTRAINT "agency_settings_split_ck" CHECK ("agency_settings"."default_split_bp" between 0 and 10000);--> statement-breakpoint
ALTER TABLE "agency_settings" ADD CONSTRAINT "agency_settings_commission_ck" CHECK (("agency_settings"."default_commission_type" = 'PCT' and "agency_settings"."default_commission_bp" between 1 and 10000 and "agency_settings"."default_commission_fixed_cents" is null and "agency_settings"."default_commission_currency" is null) or ("agency_settings"."default_commission_type" = 'FIXED' and "agency_settings"."default_commission_bp" is null and "agency_settings"."default_commission_fixed_cents" between 1 and 100000000000 and "agency_settings"."default_commission_currency" ~ '^[A-Z]{3}$'));