# Audit log archive

S1-08, S2-F1 (migration 0040). `audit_logs` is partitioned by month (pg_partman, `occurred_at`). Months stay online for **24 months**. After that, the hourly worker job `compliance.maintainPartitions` (`app_partition_maintenance()`) detaches the month and moves it to schema `audit_archive`. Nothing drops it: rows leave the database only through the steps below.

## Where things are

| What | Where |
|---|---|
| Online months | `public.audit_logs_pYYYYMMDD`, attached to `public.audit_logs` (staff viewer, agency audit log) |
| Archived months | `audit_archive.audit_logs_pYYYYMMDD`, detached, indexes kept, no grants to any app role |
| Policy | `partman.part_config` (`retention = '24 months'`, `retention_keep_table`, `retention_schema = 'audit_archive'`) |

## Partitions stop being created (maintenance skipped)

pg_partman skips a **whole** partition set when one step fails, and logs only a `WARNING` ("pg_partman maintenance skipped partition set …"). That includes creating next months, so after the 4 premade months audit inserts fail ("no partition of relation audit_logs found"). Two known causes:

- **A partition or `audit_archive` owned by another role.** Every partition and the schema must be owned by the owner of `public.audit_logs` (`app_owner`). Never run `partman.run_maintenance()` or `create_partition_time()` as a superuser: what it creates belongs to that superuser. Fix with `alter table public.<partition> owner to app_owner;` or `alter schema audit_archive owner to app_owner;`, then run `select public.app_partition_maintenance();` as the owner.
- **A lock timeout** (`lock_timeout = 5s` in the function). The next hourly run retries.

Check: `select relname from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'public.audit_logs'::regclass order by 1 desc limit 5;` shows the current month plus the next 4.

## Exporting and dropping an archived month

Do this only once the retention period agreed with legal has passed for that month. It is a human step, with a second person checking.

1. List the archived months: `select tablename from pg_tables where schemaname = 'audit_archive' order by 1;`
2. Export one as CSV over a `DATABASE_URL_ADMIN` connection: `\copy audit_archive.audit_logs_p20240801 to 'audit_logs_p20240801.csv' csv header`
3. Compress it and record its row count and SHA-256 hash. Upload it to the backups bucket (R2) under `audit-archive/`, encrypted like the WAL-G backups ([pitr-restore.md](pitr-restore.md)).
4. Download the object again and check its hash and row count against `select count(*) from audit_archive.<month>`.
5. Then drop the table: `drop table audit_archive.audit_logs_p20240801;`. Record the month, row count, hash and object key in the ops log.

A month restored from an export goes back into `audit_archive` (never re-attached), for reading by an admin connection only.
