-- S4-F3: migration 0056 deleted the DOCUMENT rows of `property_media` without an outbox event, so their objects kept
-- a reference count above 0 and were never scheduled for deletion (its comment's "the media worker's prune recounts"
-- did not hold: the prune only reads objects already scheduled). One-off recount: every object no listing uses is
-- set to 0 and scheduled like any orphan (7 days, `MEDIA_DELETE_GRACE_DAYS`). FORCE RLS hides the rows from the
-- owner running this migration: lift it inside the migration transaction and restore it.
-- migration-check: allow one-off recount; media_objects holds only pre-launch rows (no production data before the switch)
DO $$
DECLARE forced boolean;
DECLARE media_forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO forced FROM pg_class WHERE oid = 'public.media_objects'::regclass;
  SELECT relforcerowsecurity INTO media_forced FROM pg_class WHERE oid = 'public.property_media'::regclass;
  ALTER TABLE "media_objects" NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE "property_media" NO FORCE ROW LEVEL SECURITY;
  UPDATE "media_objects" o
     SET "refcount" = 0, "delete_after" = now() + interval '7 days'
   WHERE o."refcount" > 0
     AND o."delete_after" IS NULL
     AND NOT EXISTS (SELECT 1 FROM "property_media" m WHERE m."sha256" = o."sha256");
  IF forced THEN ALTER TABLE "media_objects" FORCE ROW LEVEL SECURITY; END IF;
  IF media_forced THEN ALTER TABLE "property_media" FORCE ROW LEVEL SECURITY; END IF;
END $$;
