# Postgres failover (S0-15)

db-1 is the primary; db-2 (other datacenter) is a hot standby streaming through physical slot `db_2`
(PLAN §3 #35). Failover is **manual** until Patroni (Stage C). Target: writes back within 15 minutes.

Dashboard: Grafana → Inmolink → *Postgres replication & backups*. Alerts: `infra/monitoring/rules/postgres.yml`.

## Replica lag

`PostgresReplicaLagHigh`: the standby has received WAL it has not replayed for > 60 s.

1. Grafana: lag graph and *WAL held by replication slots*. Long-running queries on db-2 can pause replay
   (`max_standby_streaming_delay` = 30 s caps that).
2. On db-2: `docker exec -u postgres postgres psql -c "select now() - pg_last_xact_replay_timestamp(), pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()"`.
3. Disk or IO saturated on db-2 (node dashboard)? Heavy batch on the primary (imports, reindex)? Lag
   that recovers by itself after a batch is acceptable; lag that grows is not — check the network
   (WireGuard: `wg show`) and db-2's disk.

## Replica not streaming

`PostgresReplicaNotStreaming` (slot inactive) or `PostgresSlotRetainingWal`.

1. db-2 up? `docker ps`, `docker logs --tail 100 postgres` on db-2.
2. WireGuard between db-1 and db-2: `wg show` (latest handshake < 2 min), `ping 10.10.0.21`.
3. Postgres on db-2 restarts itself and resumes from the slot. If the slot was invalidated
   (`max_slot_wal_keep_size` = 100 GB exceeded), re-clone:

   ```sh
   # on db-2
   docker rm -f postgres && sudo mv /srv/postgres /srv/postgres.old-$(date +%F)
   # on db-1: drop the dead slot
   docker exec -u postgres postgres psql -c "select pg_drop_replication_slot('db_2')"
   # from your machine: re-run the play for db-2 (clones again via inmolink-replica-init)
   ansible-playbook -i inventories/production site.yml --limit db-2
   ```

## Primary lost: promote db-2

Only when db-1 is really gone or unrecoverable within the target. Never run two primaries: if db-1
might come back, stop its container or block it (`ufw deny 5432`) before promoting.

1. **Fence db-1**: `ssh inmolink@db-1 sudo docker stop postgres pgbouncer` (if reachable), otherwise
   power it off in the provider console.
2. **Promote db-2**: `ssh inmolink@db-2 sudo docker exec -u postgres postgres pg_ctl promote -D /var/lib/postgresql/18/docker`.
   Check `select pg_is_in_recovery()` → `f`. WAL archiving starts on the new timeline by itself
   (`archive_mode = on`).
3. **Swap roles in the inventory**: in `infra/ansible/inventories/production/hosts.yml` move db-2 to
   `db_primary` and db-1 to `db_replica`; set `replication_slot: db_1` on db-1. Run
   `ansible-playbook -i inventories/production site.yml --limit db-2` — PgBouncer and the backup
   timer's metrics now run on db-2, Prometheus relabels primary/replica.
4. **Point the apps at db-2**: change the host in every `DATABASE_URL_*` secret (`10.10.0.21` →
   `10.10.0.31`) and redeploy: `scripts/ops/deploy.sh production` (migrations are a no-op).
5. **Take a base backup now** on db-2: `sudo systemctl start inmolink-walg-backup.service`.
6. **Rebuild the old primary as the new standby** once db-1 is back: wipe `/srv/postgres` on db-1,
   then `ansible-playbook … --limit db-1` (clones from db-2 via slot `db_1`).
7. Record the incident: timeline, data loss window (`pg_last_wal_receive_lsn` on db-2 at promotion vs
   the primary's last archived WAL), measured time to writes.

## Planned switchover (maintenance on db-1)

As above, but with zero data loss: stop writes first (`kamal app stop` for worker and api), wait until
db-2's replay LSN equals db-1's `pg_current_wal_lsn()`, then fence, promote, repoint, start the apps.
