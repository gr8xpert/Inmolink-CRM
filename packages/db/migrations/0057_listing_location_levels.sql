ALTER TABLE "properties" ADD COLUMN "country_id" uuid;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "region_id" uuid;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "city_id" uuid;--> statement-breakpoint
CREATE INDEX "properties_agency_region_idx" ON "properties" USING btree ("agency_id","region_id",date_trunc('milliseconds', "created_at", 'UTC'),"id");--> statement-breakpoint
CREATE INDEX "properties_agency_city_idx" ON "properties" USING btree ("agency_id","city_id",date_trunc('milliseconds', "created_at", 'UTC'),"id");--> statement-breakpoint
CREATE INDEX "properties_agency_location_idx" ON "properties" USING btree ("agency_id","location_id",date_trunc('milliseconds', "created_at", 'UTC'),"id");--> statement-breakpoint
-- S3-F6: backfill each listing's country, region and city. FORCE RLS hides the rows from the owner running this
-- migration (on `locations` too): lift it, inside the migration transaction, and restore it. One statement: listings
-- number in the thousands until imports land (S6); a larger table would be backfilled in batches by a script.
DO $$
DECLARE forced boolean;
DECLARE locations_forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO forced FROM pg_class WHERE oid = 'public.properties'::regclass;
  SELECT relforcerowsecurity INTO locations_forced FROM pg_class WHERE oid = 'public.locations'::regclass;
  ALTER TABLE "properties" NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE "locations" NO FORCE ROW LEVEL SECURITY;
  WITH RECURSIVE up(leaf, id, parent_id, depth) AS (
    SELECT l.id, l.id, l.parent_id, l.depth::int FROM "locations" l
     WHERE l.id IN (SELECT DISTINCT location_id FROM "properties")
    UNION ALL
    SELECT up.leaf, p.id, p.parent_id, p.depth::int FROM up JOIN "locations" p ON p.id = up.parent_id
  ), levels AS (
    SELECT leaf,
           max(id::text) FILTER (WHERE depth = 1)::uuid AS country_id,
           max(id::text) FILTER (WHERE depth = 2)::uuid AS region_id,
           max(id::text) FILTER (WHERE depth = 3)::uuid AS city_id
      FROM up GROUP BY leaf
  )
  UPDATE "properties" pr
     SET "country_id" = levels.country_id, "region_id" = levels.region_id, "city_id" = levels.city_id
    FROM levels WHERE levels.leaf = pr.location_id;
  IF forced THEN ALTER TABLE "properties" FORCE ROW LEVEL SECURITY; END IF;
  IF locations_forced THEN ALTER TABLE "locations" FORCE ROW LEVEL SECURITY; END IF;
END $$;
