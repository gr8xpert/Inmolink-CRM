-- S3-08: listings never confirmed count from their creation. Pre-launch (no production listings): one update.
-- The table FORCEs row level security (pnpm db:rls), which hides its rows from the owner running this
-- migration: lift it for the backfill, inside the migration transaction, and restore it (as 0033).
DO $$
DECLARE properties_forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO properties_forced FROM pg_class WHERE oid = 'public.properties'::regclass;
  ALTER TABLE "properties" NO FORCE ROW LEVEL SECURITY;
  UPDATE "properties" SET "last_confirmed_at" = "created_at" WHERE "last_confirmed_at" IS NULL;
  IF properties_forced THEN ALTER TABLE "properties" FORCE ROW LEVEL SECURITY; END IF;
END $$;--> statement-breakpoint
ALTER TABLE "properties" ALTER COLUMN "last_confirmed_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "properties" ALTER COLUMN "last_confirmed_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "confirm_prompted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "network_hidden_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "properties_confirm_prompt_idx" ON "properties" USING btree ("last_confirmed_at") WHERE "properties"."status" = 'ACTIVE' and "properties"."deleted_at" is null and "properties"."confirm_prompted_at" is null;--> statement-breakpoint
CREATE INDEX "properties_network_hide_idx" ON "properties" USING btree ("last_confirmed_at") WHERE "properties"."status" = 'ACTIVE' and "properties"."deleted_at" is null and "properties"."network_hidden_at" is null;