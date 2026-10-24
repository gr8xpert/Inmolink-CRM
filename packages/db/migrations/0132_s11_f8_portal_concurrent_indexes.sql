-- S11-F8: the two portal indexes 0122 built with a plain CREATE INDEX are built CONCURRENTLY by db:migrate from now on
-- (concurrent-indexes.ts, declaredBy 0122); this migration declares them, a no-op once they exist.
-- migration-check: allow built CONCURRENTLY by db:migrate before this migration (concurrent-indexes.ts); a no-op then
CREATE INDEX IF NOT EXISTS "portal_listing_sync_live_idx" ON "portal_listing_sync" USING btree ("agency_id","connection_id","property_id") WHERE "portal_listing_sync"."remote_id" is not null and "portal_listing_sync"."state" <> 'WITHDRAWN';--> statement-breakpoint
-- migration-check: allow built CONCURRENTLY by db:migrate before this migration (concurrent-indexes.ts); a no-op then
CREATE INDEX IF NOT EXISTS "agency_portal_connections_lane_idx" ON "agency_portal_connections" USING btree (hashtext("agency_id"::text),"agency_id","nightly_at") WHERE "agency_portal_connections"."enabled" and "agency_portal_connections"."revoked_at" is null;
