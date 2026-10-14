-- S2-F1: audit_logs retention per partition (STATUS Decisions, S1-08 proposal). Rows stay online for 24
-- months; then pg_partman's hourly maintenance (`app_partition_maintenance()`) detaches the whole month and
-- moves it to schema `audit_archive` instead of dropping it (`retention_keep_table`). Nothing is deleted
-- here: an archived month leaves the database only by the ops step in docs/runbooks/audit-archive.md
-- (export to object storage, verify, drop). `audit_archive` gets no grants: no app role can read or
-- change an archived month, and the tenancy guard (public schema) does not see it.
-- pg_partman requires the retention schema to be owned by the partitions' owner, and otherwise skips the whole
-- partition set in maintenance (no new months either), so the owner is taken from the parent (a test checks).
create schema if not exists audit_archive;--> statement-breakpoint
do $$ begin
  execute format('alter schema audit_archive owner to %I',
                 (select pg_get_userbyid(relowner) from pg_class where oid = 'public.audit_logs'::regclass));
end $$;--> statement-breakpoint
revoke all on schema audit_archive from public;--> statement-breakpoint
-- `app_partition_maintenance()` (app_owner) re-creates the append-only triggers on archived months.
grant execute on function audit_logs_immutable() to app_owner;--> statement-breakpoint
UPDATE partman.part_config
   SET retention = '24 months', retention_keep_table = true, retention_keep_index = true,
       retention_schema = 'audit_archive'
 WHERE parent_table = 'public.audit_logs';
