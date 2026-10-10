# Backups and point-in-time restore (S0-15)

PLAN §3 #36: WAL-G continuous archiving to Cloudflare R2 (RPO ≤ 5 min), nightly base backup, weekly
automated restore test.

| What | How | Where |
|---|---|---|
| WAL archiving | `archive_command = 'wal-g wal-push "%p"'`, `archive_timeout = 60` | the primary (`postgresql.conf.j2`) |
| Base backup + retention | `inmolink-walg-backup.timer` 02:30 Europe/Madrid → `inmolink-walg-backup` (14 full backups kept; 7 on staging) | every db host; runs only on the primary |
| Encryption | client-side libsodium (`WALG_LIBSODIUM_KEY`) before upload; R2 never sees plaintext | `walg.env` (root only) |
| Deletion protection | R2 bucket lock / retention rule ≥ 15 days on the backups bucket (set in the Cloudflare dashboard, H3), so a compromised db host cannot erase the history | Cloudflare |
| Weekly restore test | `.github/workflows/restore-drill.yml`: PITR onto the dedicated **drill host** (inventory group `drill`) over SSH, verified, timed; leftovers removed even when cancelled | GitHub Actions, Sundays 04:17 UTC |
| Alerts | `WalArchivingFailing`, `WalArchivingStale`, `BaseBackupMissing` | `infra/monitoring/rules/postgres.yml` |

The scripts live in the Postgres image (`infra/docker/postgres/bin`), so local tests, the drill and
production run the same commands: `inmolink-walg-backup`, `inmolink-pitr-prepare`, `inmolink-replica-init`.

## Restore drill (and real restores)

`pnpm ops:restore-drill` restores the store onto a **fresh Docker host** (an empty server is enough:
Docker + SSH for the `deploy` user, disk for a full copy), replays WAL to the target, promotes, checks
the server accepts writes and does not archive, runs a verification query (in `--database`, default
`inmolink`) and reports RTO. The restored server runs with `hot_standby=off`, so the backup's default
limits (e.g. `max_connections = 100` vs production's 300) cannot pause recovery:

```sh
pnpm ops:restore-drill \
  --image ghcr.io/gr8xpert/inmolink-postgres:18-3.6-walg3.0.9 \
  --walg-env ./walg-readonly.env \
  --docker-host ssh://deploy@<fresh server> \
  --target "2026-11-02T09:41:00Z" \
  --verify-sql "select count(*) from drizzle.__drizzle_migrations" \
  --report restore-drill-$(date +%F).json
```

- `--walg-env`: `WALG_S3_PREFIX`, `AWS_ENDPOINT`, `AWS_REGION=auto`, `AWS_S3_FORCE_PATH_STYLE=true`,
  `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (**read-only** R2 token), `WALG_LIBSODIUM_KEY`,
  `WALG_LIBSODIUM_KEY_TRANSFORM=hex`. Read by the local docker CLI; never logged.
- `--target` (UTC): recovery stops just before the first commit at or after it. Omit it to replay all
  archived WAL. A target older than the oldest retained base backup fails with a clear error.
- The restored cluster never archives (`archive_mode = off` is written by `inmolink-pitr-prepare`), so a
  drill cannot pollute the production store.
- Without `--keep` the drill removes its container and volume. With `--keep`, the restored server
  stays up (bridge network, no published port) for inspection or to be promoted into service.
  `pnpm ops:restore-drill --cleanup --docker-host …` removes anything a cancelled drill left behind
  (everything it creates carries the label `inmolink.restore-drill=1`).
- Report fields: `backup`, `lastReplayedCommit` (≤ target), `verifyOutput`, `rtoSeconds`
  (drill start → restored, writable, verified) and `phasesSeconds` (list, fetch base, replay, verify).

### Acceptance: PITR on a fresh server with measured RTO (needs H3/H4)

1. Note a timestamp T, then make a recognisable change after T on staging (e.g. a test agency).
2. Run the drill against a fresh server with `--target T`.
3. Check `verifyOutput` shows the state at T (the change is absent) and record `rtoSeconds` and the
   database size in STATUS. Locally the same flow runs in `tests/ops/pitr.int.test.ts` against MinIO.

## Using a restore for real

1. Drill with `--keep` and the chosen `--target` onto a fresh server (or db-2 if it is the only
   machine left), check the data.
2. **Turn archiving back on** — the drill disabled it in `postgresql.auto.conf`, which overrides the
   Ansible config:

   ```sh
   docker exec -u postgres <container> psql -c "alter system reset archive_mode" -c "alter system reset restore_command"      -c "alter system reset recovery_target_time" -c "alter system reset recovery_target_action"
   docker restart <container>
   docker exec -u postgres <container> psql -c "show archive_mode"   # on
   ```

   It archives on a new timeline into the same prefix, so the store stays one history.
3. Make it the primary: follow `failover.md` steps 3–7 with the restored server in place of db-2
   (it needs the Ansible baseline first: add it to the inventory and run `site.yml --limit <host>`,
   moving the restored data directory to `/srv/postgres`). Check `select * from pg_stat_archiver`
   shows new archived segments, then take a base backup.

## Archiving failing

`WalArchivingFailing` / `WalArchivingStale`:

1. `docker logs --tail 200 postgres | grep -i wal-g` on the primary — credentials, R2 outage, DNS.
2. `select * from pg_stat_archiver` — `last_failed_wal`, `failed_count`.
3. WAL piles up in `pg_wal` while archiving fails: watch disk. Postgres retries forever; fixing the
   cause drains the backlog. Do **not** delete files from `pg_wal`.

## Base backup missing

`BaseBackupMissing`: `systemctl status inmolink-walg-backup.service` and
`journalctl -u inmolink-walg-backup.service` on the primary; rerun with
`sudo systemctl start inmolink-walg-backup.service`. List backups:
`docker exec postgres wal-g backup-list --detail`.
