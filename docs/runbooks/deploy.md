# Deploy (S0-15)

Topology (PLAN §5.5 Stage A): **app-1** (kamal-proxy + every app + redis-cache + Meilisearch) and
**db-1** (Postgres primary, PgBouncer, redis-queue) in one datacenter; **db-2** (hot standby,
Prometheus/Alertmanager/Grafana) in another. Staging is one server (`staging-1`) running all of it
without a standby. Hosts talk over a WireGuard mesh (`10.10.0.0/24`, staging `10.20.0.0/24`).

| Piece | Where | Managed by |
|---|---|---|
| Host baseline: users, SSH, ufw, unattended upgrades, fail2ban, WireGuard, Docker, node_exporter | all hosts | `infra/ansible` (`site.yml`) |
| Postgres 18 (repo image + WAL-G), PgBouncer, postgres_exporter, nightly base backup timer | db hosts | Ansible role `postgres` |
| redis-queue (AOF, noeviction, password) | db-1 | Ansible role `redis_queue` |
| Prometheus, Alertmanager, Grafana (+ Watchdog → external heartbeat) | db-2 / staging-1 | Ansible role `monitoring` |
| Weekly restore drill target (Docker only, no secrets at rest) | drill-1 | Ansible baseline; `.github/workflows/restore-drill.yml` |
| api, feed-api, realtime, worker, web, public | app-1 | Kamal (`infra/kamal/<app>.yml`) |
| redis-cache, Meilisearch | app-1 | Kamal accessories of `infra/kamal/api.yml` |

Images: CI builds `ghcr.io/gr8xpert/inmolink-<app>:<git sha>` for every commit on `main` (after the
`required` check) and `ghcr.io/gr8xpert/inmolink-postgres:<tag>` from `infra/docker/postgres`. Deploys
never build.

## Prerequisites (one time)

Blocked on H3 (accounts), H4 (servers), H5 (DNS) — `docs/build/HUMAN-ACTIONS.md`.

1. Replace the placeholder addresses in `infra/ansible/inventories/<env>/hosts.yml` and the
   `infra/kamal/*.<env>.yml` files (`203.0.113.x` / `198.51.100.x` are documentation ranges).
2. `cp infra/ansible/inventories/<env>/group_vars/all/vault.example.yml …/vault.yml`, fill it in,
   `ansible-vault encrypt …/vault.yml`. Keep `vault_walg_libsodium_key` in the password manager too:
   **without it no backup can be read.**
3. Cloudflare: DNS for `app`, `api`, `feed`, `realtime`, `sites` (`.staging`) → app host, proxied;
   SSL mode **Full (strict)**; create an origin certificate for `*.inmolink.es` + `*.staging.inmolink.es`.
   R2: bucket `inmolink-backups-<env>`, one read/write token for the db hosts, one **read-only**
   token for the restore drill.
4. `cp .kamal/secrets.example .kamal/secrets.<env>` (references only, `KEY=$KEY`); the values come from
   your shell or the GitHub `production`/`staging` environment. Install Kamal 2.12 (`gem install kamal -v 2.12.0`).
   GitHub → Settings → Environments → `production`: deployment branches **`main` only** (the drill key
   and WAL-G token live there).
   SSH keys: admins (`vault_admin_ssh_keys`) reach every host; the Kamal CI key
   (`vault_deploy_ssh_keys`) only app hosts; the drill key (`vault_drill_ssh_keys`) only the drill host.
   DB hosts accept operators only — run `deploy.sh` from an operator machine.
5. Converge the hosts (first run as root or the provider's initial user, then as `inmolink`):

   ```sh
   cd infra/ansible
   ansible-galaxy collection install -r requirements.yml
   ansible-playbook -i inventories/staging site.yml --ask-vault-pass
   ```

   The primary takes its first base backup at the end of the run; the standby clones the primary
   through slot `db_2` (`inmolink-replica-init`).
   The docker role creates the `kamal` network on `kamal_network_subnet` (10.200.0.0/24), which the apps
   trust as their proxy hop. It must exist before the first `kamal setup`; on a host where Kamal already
   created it, stop the containers, `docker network rm kamal` and re-run the playbook.
6. Boot the accessories: `kamal accessory boot all -c infra/kamal/api.yml -d staging`. redis-cache
   refuses to start without `REDIS_CACHE_PASSWORD` (`openssl rand -hex 32`); every app's `REDIS_CACHE_URL`
   is `redis://:<that password>@inmolink-api-redis-cache:6379`.
   Rate-limit counters live on redis-queue, which never evicts (S1-F6): api, feed-api and web get
   `REDIS_LIMITS_URL=redis://limits:<vault_redis_limits_password>@<db-1 WireGuard IP>:6379`. The Ansible
   redis_queue role creates that ACL user, limited to `inl:rl:*` keys and the limiter's commands.
   The media container (S3-F7) decodes untrusted uploads, so it gets its own credentials (Kamal `ENV:SECRET`
   aliases in `infra/kamal/worker.yml`) and no `REDIS_CACHE_URL`:
   - `REDIS_QUEUE_URL_MEDIA=redis://media:<vault_redis_media_password>@<db-1 WireGuard IP>:6379` — the redis_queue
     role's `media` ACL user (`redis_media_acl`): its own BullMQ keys (`inl:media:*`, `inl:media.dead:*`,
     `inl:fair:media:*`), no other pool's queue, no key listing, no admin command.
   - `S3_MEDIA_ACCESS_KEY_ID` / `S3_MEDIA_SECRET_ACCESS_KEY` (H3): an R2 API token, **Object Read & Write**,
     *Apply to specific buckets only* → `inmolink-media` and `inmolink-media-work`. Never the exports or the
     private bucket. The other workers keep the `S3_ACCESS_KEY_ID` token.
     R2 API tokens scope to whole buckets, not prefixes, so originals and masters live in their own bucket
     (S3-F9): create `inmolink-media-work` (no public access, no custom domain) next to the others. The local
     stack enforces the same bucket-level scope (`infra/storage/media-worker-policy.json`).
     S7-F3: feed images past 5 MiB stream to `feed-staging/` in `inmolink-media-work` (workers' token, Object Read &
     Write) and move by CopyObject. On that bucket add the lifecycle rule **Abort incomplete multipart uploads after
     1 day, prefix `feed-staging/`** (R2 → bucket → Settings → Object lifecycle rules): a job that dies mid-upload
     leaves parts no listing shows; completed leftovers are swept by `media.pruneOrphans`.
   - `S3_FEEDS_ACCESS_KEY_ID` / `S3_FEEDS_SECRET_ACCESS_KEY` (H3, S7-07): feed-api's R2 API token, **Object Read
     only**, *Apply to specific buckets only* → `inmolink-feeds` (per-site XML feeds, `site-feeds/<site>/<run>/`).
     Create the bucket `inmolink-feeds` (no public access, no custom domain) first and add it to the workers'
     `S3_ACCESS_KEY_ID` token (Object Read & Write; the exports pool writes the feeds). `S3_BUCKET_FEEDS` names it
     (Kamal); unset, the feeds go to the exports bucket (local stacks only).
   Then create the Meilisearch **search-only** key for api and feed-api (they never get the master key;
   production config refuses it for http apps) and put its `key` in `MEILI_SEARCH_KEY`:

   ```sh
   curl -sX POST http://<meili>:7700/keys -H "Authorization: Bearer $MEILI_MASTER_KEY" \
     -H 'Content-Type: application/json' \
     -d '{"name":"request-apps","actions":["search"],"indexes":["*"],"expiresAt":null}'
   ```

   And the worker's **indexing** key (S5-02): settings, documents and tasks of the listings indexes only — never
   the master key, which can create keys. Put its `key` in `MEILI_INDEXING_KEY` (the worker reads it as
   `MEILI_MASTER_KEY`):

   ```sh
   curl -sX POST http://<meili>:7700/keys -H "Authorization: Bearer $MEILI_MASTER_KEY"      -H 'Content-Type: application/json'      -d '{"name":"indexing","actions":["search","documents.*","indexes.*","settings.*","tasks.get","stats.get"],"indexes":["listings*"],"expiresAt":null}'
   ```

   The worker applies the listings index settings at boot (retrying until search answers). After the first deploy
   that carries migration 0065 (read-model share scope), run `pnpm ops:rebuild-read-models` once: rows written
   before it count as PREFERRED (narrowest) until rebuilt.

   Turnstile (H3): create a widget for `app.inmolink.es` (+ staging) and set `TURNSTILE_SITE_KEY` /
   `TURNSTILE_SECRET_KEY` for web. Without them, the per-email login ceiling is a hard block again.
7. First deploy creates the app roles: export `DATABASE_URL_ADMIN=postgres://postgres:<superuser
   password>@127.0.0.1:5432/inmolink` in your shell, then `scripts/ops/deploy.sh staging --bootstrap-roles`.
   The URL travels over SSH stdin into the one-off container; it is never written to the hosts.

## Every deploy

```sh
git checkout <commit on main whose CI is green>
scripts/ops/deploy.sh staging            # then: scripts/ops/deploy.sh production
```

1. **Database** — once, on the primary db host, in a one-off worker-image container with
   `/etc/inmolink/migrate.env` (owner credentials never reach app-1): migrations, then RLS from the
   tenant registry, then the guard (`packages/db/dist/cli/deploy.js`). Any guard problem stops the
   deploy before an app starts. Migrations must work with the release that is still running
   (expand → deploy → contract, PLAN §18).
2. **Apps**, in order `worker api feed-api realtime public web`: `kamal deploy --skip-push --version <sha>`.
   kamal-proxy starts the new container, waits until `/readyz` (Node) or `/healthz` (Next) passes,
   moves traffic to it, then drains the old one (`drain_timeout` 30 s; apps keep serving with
   `/readyz` failing for `SHUTDOWN_DRAIN_DELAY_MS`). Workers stop with a 90 s grace period.

One app only: `scripts/ops/deploy.sh staging --only api` (migrations still run first).

### Zero-downtime check (acceptance, manual — needs staging)

While a deploy runs, from another terminal:

```sh
while true; do
  code=$(curl -s -o /dev/null -w '%{http_code}' https://api.staging.inmolink.es/healthz)
  [ "$code" = 200 ] || echo "$(date +%T) $code"; sleep 0.2
done
```

No line may be printed during `scripts/ops/deploy.sh staging --only api`. Record the result in STATUS.

## Edge

Cloudflare (proxied, Full strict) → kamal-proxy on app-1. App hosts accept 80/443 **only** from
Cloudflare's ranges (`inmolink-origin-lock`, rules in `DOCKER-USER` because Docker-published ports
bypass ufw), so the WAF cannot be skipped. Apps set `TRUST_PROXY` to the `kamal` Docker network
(`kamal_network_subnet`) + the same Cloudflare ranges, so `request.ip` is the client. The Workers
egress range `2a06:98c0::/29` (`cloudflare_workers_ips`) passes the origin lock but is never trusted:
any Cloudflare customer's Worker sends from it with headers of its choosing. Cloudflare Authenticated Origin Pulls (mTLS) would also need
kamal-proxy to verify client certificates, which it does not do. Both lists come from `cloudflare_ips` in
`infra/ansible/group_vars/all.yml` (a workspace test keeps the Kamal copies in sync); Cloudflare
changes them rarely — check https://www.cloudflare.com/ips/ when bumping.

## Rollback

`kamal rollback <previous sha> -c infra/kamal/<app>.yml -d <env>` per app (Kamal keeps the last 5
containers). Migrations are not rolled back: ship a new forward migration instead.

## Useful commands

| What | Command |
|---|---|
| Logs | `kamal app logs -f -c infra/kamal/api.yml -d production` |
| Shell in a running app | `kamal app exec -i --reuse -c infra/kamal/api.yml -d production sh` |
| Grafana | `ssh -L 3000:10.10.0.31:3000 inmolink@db-2` → http://localhost:3000 |
| Postgres shell | `ssh inmolink@db-1 sudo docker exec -it -u postgres postgres psql -d inmolink` |
| Re-converge one host | `ansible-playbook -i inventories/production site.yml --limit db-1` |

## Not yet covered

- App `/metrics` scraping (ports are off in production; needs a scrape path into Kamal's containers).
- Trace export backend (Tempo or Better Stack): `OTEL_EXPORTER_OTLP_ENDPOINT` is unset in production.
- Automated failover (Patroni) is Stage C; see `failover.md` for the manual procedure.
