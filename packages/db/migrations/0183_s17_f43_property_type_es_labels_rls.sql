-- S17-F43: migration 0182 changed nothing on staging. FORCE RLS hides the rows from the owner running a migration and
-- it has no policy here, so its select found no English names and it inserted none, without an error (the test ran it
-- as app_system, which has a policy). Same insert with FORCE lifted inside the migration transaction and restored,
-- the pattern of 0062 and 0063. Idempotent; a slug already taken in Spanish is left alone.
DO $$
DECLARE forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO forced FROM pg_class WHERE oid = 'public.property_type_translations'::regclass;
  ALTER TABLE "property_type_translations" NO FORCE ROW LEVEL SECURITY;
  INSERT INTO "property_type_translations" ("type_id", "locale", "name", "slug")
  SELECT t."type_id", 'es', m.es_name, m.es_slug
    FROM "property_type_translations" t
    JOIN (VALUES
      ('plot', 'Parcela', 'parcela'),
      ('semi-detached house', 'Casa pareada', 'casa-pareada'),
      ('semi-detached', 'Casa pareada', 'casa-pareada')
    ) AS m(en_name, es_name, es_slug) ON lower(t."name") = m.en_name
   WHERE t."locale" = 'en'
     AND NOT EXISTS (SELECT 1 FROM "property_type_translations" x WHERE x."type_id" = t."type_id" AND x."locale" = 'es')
  ON CONFLICT DO NOTHING;
  IF forced THEN ALTER TABLE "property_type_translations" FORCE ROW LEVEL SECURITY; END IF;
END $$;
