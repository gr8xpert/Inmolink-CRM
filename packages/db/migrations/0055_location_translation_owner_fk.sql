-- S3-F3: the composite (location_id, parent_id) FK is MATCH SIMPLE, so a root location's translations (parent_id
-- NULL) were never bound to it and outlived a deleted country. Remove those orphans, then bind every translation
-- to its location. The table FORCEs row level security (pnpm db:rls), which hides its rows from the owner running
-- this migration: lift it for the cleanup, inside the migration transaction, and restore it.
DO $$
DECLARE forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO forced FROM pg_class WHERE oid = 'public.location_translations'::regclass;
  ALTER TABLE "location_translations" NO FORCE ROW LEVEL SECURITY;
  DELETE FROM "location_translations" t WHERE NOT EXISTS (SELECT 1 FROM "locations" l WHERE l.id = t.location_id);
  IF forced THEN ALTER TABLE "location_translations" FORCE ROW LEVEL SECURITY; END IF;
END $$;--> statement-breakpoint
ALTER TABLE "location_translations" ADD CONSTRAINT "location_translations_owner_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;
