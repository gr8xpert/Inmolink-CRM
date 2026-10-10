# ADR 0007 — Backups and high availability

- **Status:** Accepted (built in S0-15 against fixtures; production acceptance waits on H3, H4, H5)
- **Date:** 2026-10-11
- **Task:** S0-15, S0-16 (PLAN §3 #35 #36 #37 #40, §4.2, §5.4, §5.5)

## Context

The SLOs are RPO ≤ 5 min and RTO ≤ 30 min in R1, falling to ≤ 10 min in R3 (PLAN §4.2). Plan v1 had a nightly dump and a replica on the same box, which loses up to a day of data and dies with the server. Stage A runs on a small number of EU dedicated servers, without a managed database. We are a solo operator at first, so automated failover (Patroni) is more risk than benefit before Stage C.

## Decision

### Postgres
- **One image everywhere:** PG 18 + PostGIS + pgvector + pg_trgm + pg_partman + WAL-G 3.0.9 + ops scripts (`infra/docker/postgres`), used locally, in CI and on db hosts. Tags are immutable, so a Dockerfile change needs a new tag.
- **Postgres, PgBouncer, redis-queue and monitoring are host config managed by Ansible** (`infra/ansible`), not Kamal. Data lives on the host. Kamal manages only stateless apps and rebuildable accessories (redis-cache, Meilisearch).
- **Primary db-1 + hot standby db-2 in another datacenter** through streaming replication over a WireGuard mesh (`wg0`). Nothing internal listens on a public address. Alert `PostgresReplicaLagHigh` fires when lag stays above 60 s.
- **Failover is manual until Patroni (Stage C).** Runbook `docs/runbooks/failover.md`: fence, promote, swap inventory groups, repoint `DATABASE_URL_*`, redeploy, re-clone the old primary. Target: writes back within 15 min.

### Backups
- **WAL-G continuous archiving to R2** with `archive_timeout = 60` (RPO well under 5 min), client-side libsodium encryption, and a nightly base backup (14 kept in production, 7 on staging).
- **R2 bucket lock or retention ≥ 15 days** and separate delete credentials, so a compromised db host cannot erase history (H3).
- **Weekly automated restore test:** `pnpm ops:restore-drill` runs PITR onto a dedicated drill host over `DOCKER_HOST=ssh://` with a read-only R2 token, from GitHub Actions. It reports RTO and keeps the reports as artifacts. Not on db-2, because a full restore would compete with the standby for IO.
- Alerts `WalArchivingFailing`, `WalArchivingStale` and `BaseBackupMissing`. Monitoring runs on db-2 with a Watchdog heartbeat to an external monitor.

### Redis
- **Two instances:** `redis-queue` (noeviction, AOF; BullMQ needs it) and `redis-cache` (allkeys-lru). A lost queue is recoverable because the outbox lives in Postgres (`pnpm ops:replay-outbox`). A lost cache only means a slower origin.

### Deploys
- `scripts/ops/deploy.sh <env>`: migrations, then RLS from the compiled registry, then the guard on the primary (`packages/db/dist/cli/deploy.js`), then Kamal per app. Any guard problem fails the deploy. Schema changes are expand → migrate → contract (PLAN §3 #41).

## Consequences

- Losing db-1 costs at most about a minute of writes. Websites keep serving from the CDN meanwhile (ADR 0012).
- A manual failover depends on an operator being reachable. Alerting has to be phone-grade, and the runbook is rehearsed in the S16-02 chaos drills.
- Restore is proven weekly, not assumed. A drill that fails is an incident.
- Host config lives in Ansible and app config in Kamal, so changing a Postgres setting is an Ansible run, not a deploy.
- Patroni, read replicas and Redis Sentinel arrive at Stage B/C, each with its own ADR (PLAN §5.6).
