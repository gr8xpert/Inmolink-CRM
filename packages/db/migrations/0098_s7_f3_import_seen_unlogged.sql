ALTER TABLE "property_import_seen" DROP CONSTRAINT "property_import_seen_agency_id_agencies_agency_id_fk";
--> statement-breakpoint
DROP INDEX "property_import_seen_agency_created_idx";--> statement-breakpoint
-- S7-F3: a run's seen references live for that run only, so they are not WAL-logged. A crash or a failover empties the
-- table under a run that may carry on: the run keeps a logged count (`feed_runs.items_seen`, 0100) and, before the
-- missing-listing anti-join, a mismatch fails it retryably — the next attempt resets both and reads the feed again.
-- SET UNLOGGED rewrites the table under ACCESS EXCLUSIVE: deploy with the imports pool drained.
-- No foreign key (like the staging table): the agency index it needed was unused.
ALTER TABLE "property_import_seen" SET UNLOGGED;--> statement-breakpoint
-- About 2M rows inserted and deleted an hour at 5,000 agencies: vacuum after a fixed number of dead rows (not 20 % of a
-- table whose size swings), without throttling, and keep the planner's statistics fresh for the anti-join.
ALTER TABLE "property_import_seen" SET (
  autovacuum_vacuum_scale_factor = 0,
  autovacuum_vacuum_threshold = 50000,
  autovacuum_vacuum_insert_scale_factor = 0,
  autovacuum_vacuum_insert_threshold = 100000,
  autovacuum_analyze_scale_factor = 0,
  autovacuum_analyze_threshold = 100000,
  autovacuum_vacuum_cost_delay = 0
);
