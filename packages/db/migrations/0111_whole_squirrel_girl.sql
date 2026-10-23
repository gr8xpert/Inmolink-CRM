ALTER TABLE "developments" ADD COLUMN "from_feed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "developments" ADD COLUMN "locked_fields" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "developments" ADD CONSTRAINT "developments_locked_fields_ck" CHECK ("developments"."locked_fields" <@ array['name', 'location']::text[]);--> statement-breakpoint
-- S8-F5: developments a feed created before this migration are feed developments — S8-F3 (0110) marked only their
-- units. FORCE RLS hides the rows from the owner running this migration: lift it on both tables inside the migration
-- transaction and restore it (as 0063). `developments` is small (pre-launch; not a large table).
DO $$
DECLARE dev_forced boolean;
DECLARE units_forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO dev_forced FROM pg_class WHERE oid = 'public.developments'::regclass;
  SELECT relforcerowsecurity INTO units_forced FROM pg_class WHERE oid = 'public.units'::regclass;
  ALTER TABLE "developments" NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE "units" NO FORCE ROW LEVEL SECURITY;
  UPDATE "developments" d
     SET "from_feed" = true
   WHERE NOT d."from_feed"
     AND EXISTS (SELECT 1 FROM "units" u
                  WHERE u."development_id" = d."id" AND u."agency_id" = d."agency_id" AND u."from_feed");
  IF dev_forced THEN ALTER TABLE "developments" FORCE ROW LEVEL SECURITY; END IF;
  IF units_forced THEN ALTER TABLE "units" FORCE ROW LEVEL SECURITY; END IF;
END $$;
