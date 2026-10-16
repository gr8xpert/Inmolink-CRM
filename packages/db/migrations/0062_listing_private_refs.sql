ALTER TABLE "properties" DROP CONSTRAINT "properties_quality_ck";--> statement-breakpoint
DROP INDEX "properties_source_ref_uq";--> statement-breakpoint
ALTER TABLE "property_privates" ADD COLUMN "external_source" text;--> statement-breakpoint
ALTER TABLE "property_privates" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "property_privates" ADD COLUMN "quality_score" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "property_privates_source_ref_uq" ON "property_privates" USING btree ("agency_id","external_source","external_ref") WHERE "property_privates"."external_ref" is not null;--> statement-breakpoint
-- S4-F1: the owner's feed reference and quality score move to the owner-only `property_privates` (a listing
-- created without a private row gets one). FORCE RLS hides the rows from the owner running this migration: lift it
-- inside the migration transaction and restore it. One statement: listings number in the thousands until imports land.
DO $$
DECLARE forced boolean;
DECLARE privates_forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO forced FROM pg_class WHERE oid = 'public.properties'::regclass;
  SELECT relforcerowsecurity INTO privates_forced FROM pg_class WHERE oid = 'public.property_privates'::regclass;
  ALTER TABLE "properties" NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE "property_privates" NO FORCE ROW LEVEL SECURITY;
  INSERT INTO "property_privates" ("property_id", "agency_id", "external_source", "external_ref", "quality_score")
  SELECT p."id", p."agency_id", CASE WHEN p."external_ref" IS NOT NULL THEN p."source" END, p."external_ref", p."quality_score"
    FROM "properties" p
   WHERE p."external_ref" IS NOT NULL OR p."quality_score" IS NOT NULL
  ON CONFLICT ("property_id") DO UPDATE
     SET "external_source" = EXCLUDED."external_source",
         "external_ref" = EXCLUDED."external_ref",
         "quality_score" = EXCLUDED."quality_score";
  IF forced THEN ALTER TABLE "properties" FORCE ROW LEVEL SECURITY; END IF;
  IF privates_forced THEN ALTER TABLE "property_privates" FORCE ROW LEVEL SECURITY; END IF;
END $$;--> statement-breakpoint
ALTER TABLE "properties" DROP COLUMN "external_ref";--> statement-breakpoint
ALTER TABLE "properties" DROP COLUMN "quality_score";--> statement-breakpoint
ALTER TABLE "property_privates" ADD CONSTRAINT "property_privates_external_ck" CHECK (("property_privates"."external_source" is null) = ("property_privates"."external_ref" is null));--> statement-breakpoint
ALTER TABLE "property_privates" ADD CONSTRAINT "property_privates_quality_ck" CHECK ("property_privates"."quality_score" is null or "property_privates"."quality_score" between 0 and 100);