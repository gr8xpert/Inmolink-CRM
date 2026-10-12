-- S1-F2: outbox_events is a queue — every row is inserted, updated twice (claim, acknowledge) and deleted
-- after retention. The defaults (vacuum at 20 % dead tuples, analyze at 10 %) let millions of dead tuples
-- and bloat in the partial pending index build up between runs at 2,000 events/s. Vacuum and analyze
-- early and often; a small, fast table is cheap to vacuum.
ALTER TABLE "outbox_events" SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_threshold = 5000,
  autovacuum_vacuum_insert_scale_factor = 0.05,
  autovacuum_vacuum_insert_threshold = 10000,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 5000,
  autovacuum_vacuum_cost_delay = 1
);
