-- S14 review: legacy redirects are keyed by host (plugin pages of two agencies share paths) and the target CHECK refuses
-- `/\host` and control characters. The table is new and empty in production (no redirect is built before S15):
-- rows written without a host by earlier test runs are dropped (the build script rewrites them).
DELETE FROM "legacy_url_redirects";--> statement-breakpoint
ALTER TABLE "legacy_url_redirects" DROP CONSTRAINT "legacy_url_redirects_target_ck";--> statement-breakpoint
DROP INDEX "legacy_url_redirects_key_uq";--> statement-breakpoint
ALTER TABLE "legacy_url_redirects" ADD COLUMN "host" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_url_redirects_key_uq" ON "legacy_url_redirects" USING btree ("source","host","locale","path_key");--> statement-breakpoint
ALTER TABLE "legacy_url_redirects" ADD CONSTRAINT "legacy_url_redirects_host_ck" CHECK ("legacy_url_redirects"."host" ~ '^[a-z0-9-]+(\.[a-z0-9-]+)*$');--> statement-breakpoint
ALTER TABLE "legacy_url_redirects" ADD CONSTRAINT "legacy_url_redirects_target_ck" CHECK ("legacy_url_redirects"."target_path" ~ '^/(?![/\\])[^\x01-\x1f\\]*$');