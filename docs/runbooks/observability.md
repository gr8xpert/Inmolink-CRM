# Observability: dashboards, SLO alerts, probes and the status page (S16-05)

PLAN §17. Prometheus, Alertmanager, Grafana and blackbox_exporter run on the monitoring host (Ansible role
`monitoring`; Stage A: db-2, the other datacenter). Every alert links here or to another runbook through its `runbook`
annotation; the full list is [alerts.md](alerts.md).

## Where things are

| What | Where |
|---|---|
| Alert rules + promtool tests | `infra/monitoring/rules/*.yml`, `*.test.yml` (`tests/ops/alerts.int.test.ts`) |
| Dashboards (provisioned into Grafana folder *Inmolink*) | `infra/grafana/dashboards/*.json` — one per service (`service-api`, `service-feed-api`, `service-realtime`, `service-worker`), plus SLO error budgets, endpoints & certificates, hosts, Postgres replication & backups, worker queues, HTTP RED |
| Endpoint probes | `endpoint_probes` in `infra/ansible/inventories/<env>/group_vars/all/main.yml` |
| Status page monitors | `infra/monitoring/status-page.yml` |
| Staged-firing plan | `pnpm ops:alerts list` (`scripts/ops/alerts.ts`) |
| Grafana | `ssh -L 3000:<wg_ip>:3000 inmolink@db-2` → http://localhost:3000 |
| Prometheus | `ssh -L 9090:<wg_ip>:9090 inmolink@db-2` → http://localhost:9090/alerts |

`tests/workspace/monitoring.test.ts` keeps it honest: every alert has a runbook heading, a promtool case where it fires,
a row in alerts.md and a staged trigger; every dashboard query reads a metric the code or an exporter emits; every app
with a `/metrics` port has a dashboard; the probes match the Kamal proxy hosts.

## Alert routing

Alertmanager (`roles/monitoring/templates/alertmanager.yml.j2`): every alert by e-mail to `alert_email_to`; `critical`
also to the on-call webhook (`vault_oncall_webhook_url`: phone call / push from the hosted on-call provider, H3) and
repeated hourly; `Watchdog` to the dead-man switch. Severity rule of thumb: *critical* = users are affected now or data is
at risk (pages); *warning* = degraded or heading there (e-mail, look within the working day).

Every notification carries `runbook_url`: `runbook_base_url` (group_vars/all.yml, the repository's main branch) + the
alert's `runbook` path — Prometheus external label `runbook_base`, used by the rule annotations. Notifications are
grouped by alert, `service` and `instance`.

Inhibitions (one cause, one notification): `NodeDown` mutes `EndpointDown` of the same `host`; `EndpointDown` mutes
`AppMetricsDown` and the uptime burn alerts of the same `service`; `SloErrorBudgetBurnFast` mutes the slow burn of the
same SLO; `CertificateExpiryCritical` mutes `CertificateExpiringSoon` of the same `instance`. A muted alert still shows
in Prometheus (`/alerts`) and Grafana — only its notification is held back. Not inhibited: `AppMetricsDown` of the
worker by `NodeDown` (the worker has no probe and the alert no host).

## Watchdog heartbeat

`Watchdog` always fires. Alertmanager pings `vault_heartbeat_url` every minute; the external service pages when the pings
stop for 5 minutes — Prometheus, Alertmanager or the monitoring host is down, so nothing else can alert.

1. `ssh inmolink@db-2 docker ps --filter name=prometheus --filter name=alertmanager` — both running?
2. Down: `docker start prometheus alertmanager`; host down: it is db-2 — check the Postgres standby too (failover.md).
3. Still no pings: the heartbeat URL changed or egress is blocked (`docker logs alertmanager | grep heartbeat`).

## SLO error budget burn

`SloErrorBudgetBurnFast` (critical: 14.4× over 1 h and 5 min — the 30-day budget gone in ~2 days) and
`SloErrorBudgetBurnSlow` (warning: 6× over 6 h and 30 min). Labels `service` and `slo`:

| slo | SLI | Objectives (PLAN §4.2) |
|---|---|---|
| availability | share of 5xx answers (`http_server_request_duration_count`; /readyz and /healthz left out) | feed-api 99.95 %, api 99.9 % |
| latency | share of non-5xx requests over budget: feed-api 150 ms, api 300 ms | 95 % within budget (a p95) |
| uptime | share of failed public probes (blackbox) | web 99.9 %, public 99.9 % |

Both alerts need traffic: more than 100 requests (10 probes) in the long window, so one error on a quiet night does
not page. The 30-day budget on *Inmolink · SLO error budgets* is traffic-weighted (bad / total events, Prometheus keeps
35 days).

1. Open *Inmolink · Service · <service>*: which routes fail or are slow, since when? A deploy at that time → roll back
   (`kamal rollback`, deploy.md › Rollback) first, investigate after.
2. availability: 5xx by route. All routes → a dependency: Postgres (failover.md), redis (website-api.md › Redis memory),
   Meilisearch (search.md › Fallback active). One route → its logs: `kamal app logs -c infra/kamal/<app>.yml -d production
   | grep '"statusCode":5'`.
3. latency: slow routes. Postgres (Hosts dashboard: CPU, IO; `pg_stat_activity` for long queries), search fallback
   active (fallback queries are slower), a feed storm on the same host (queues.md › Feed storm).
4. uptime: see Endpoint down.
5. Post on the status page if agencies are affected for more than 5 minutes (Status page below).

## App metrics down

`AppMetricsDown`: no target of `api`, `feed-api`, `realtime` or `worker` is scraped. Every `inmolink_*` alert and the
request SLOs of that service are blind.

1. The app is down → it is an outage: EndpointDown fires too; deploy.md, `kamal app details -c infra/kamal/<app>.yml`.
2. The app is up → the scrape path is broken: the app's `*_METRICS_PORT` is `0` or unreachable from the monitoring
   host. **Open (S16-05):** production apps still run with `*_METRICS_PORT: "0"` (deploy.md › Not yet covered): until a
   scrape path into Kamal's containers exists (S16-F6) this alert fires on purpose.

## Endpoint down

`EndpointDown` (critical): a public health URL (`/readyz` or `/healthz` through Cloudflare) failed for 2 minutes from the
monitoring host. `EndpointProbesMissing`: blackbox_exporter itself is down or unscraped (`docker start blackbox-exporter`
on the monitoring host).

1. Is it us or the path? `curl -sS -o /dev/null -w '%{http_code}\n' <instance URL>` from your machine and from the
   monitoring host. 5xx from Cloudflare (520–526) → origin unreachable: app host, kamal-proxy, origin lock
   (`sudo iptables -L INMOLINK-ORIGIN`).
2. `/readyz` 503 → a dependency check fails (Postgres, redis, rate-limit scripts): the app log names it.
3. Containers: `kamal app details -c infra/kamal/<app>.yml -d production`; restart with `kamal app boot`.
4. The status page shows the same outage from outside within ~2 minutes; post an incident there.

## Certificate expiry

`CertificateExpiringSoon` (< 14 days, warning) and `CertificateExpiryCritical` (< 3 days, critical) read the certificate
the probe was served — Cloudflare's edge certificate for the public hosts (renewed by Cloudflare). If it expires anyway:
Cloudflare dashboard → SSL/TLS → Edge Certificates: the universal / advanced certificate's status (a DNS validation that
stopped working, a CAA record blocking the CA).

`job="blackbox-origin"`: the origin certificate kamal-proxy serves behind Cloudflare Full (strict), probed at each app
host's WireGuard address with SNI = the public host (a Cloudflare Origin CA certificate, deploy.md step 3; the probe does
not verify its chain). When it expires Cloudflare answers 526 for every request: create a new origin certificate in the
Cloudflare dashboard (SSL/TLS → Origin Server), put it in the Kamal secrets `CLOUDFLARE_ORIGIN_CERT_PEM` /
`CLOUDFLARE_ORIGIN_KEY_PEM` and redeploy every app behind the proxy (api, feed-api, realtime, web, public).

## Node down

`NodeDown`: node_exporter on a host does not answer for 2 minutes. Host down, WireGuard down between it and the monitoring
host (`sudo wg show` on both), or the exporter stopped (`sudo systemctl status node_exporter`). A database host down:
failover.md first.

## Disk usage

`DiskUsageHigh` (critical, PLAN §17): a real filesystem over 70 % for 15 minutes.

1. `df -h` and `sudo du -xh --max-depth=2 <mountpoint> | sort -h | tail` on the host.
2. Postgres hosts: WAL held by a slot (`PostgresSlotRetainingWal`, failover.md › Replica not streaming), archiving
   failing (WAL piles up: pitr-restore.md › Archiving failing), table bloat after a big import.
3. App hosts: old images (`docker image prune -a --filter until=168h` — Kamal keeps the last 5 containers), container
   logs (`/var/lib/docker/containers/*/*-json.log`).
4. Growth is expected (more agencies): grow the volume before 85 %.

## Status page

Hosted (decision S16-05, `infra/monitoring/status-page.yml`): status.inmolink.es, probed from several regions outside our
servers, so it stays up when we are down. **BLOCKED-HUMAN:** provider account (H3) and the `status` CNAME (H5).

Setup (once): create the account; add one HTTP monitor per `components` entry (URL, 60 s, 2 confirmations, regions EU
+ US, expect 200); build the status page with the components in file order; custom domain `status.inmolink.es`; copy
the provider's Alertmanager/on-call webhook into `vault_oncall_webhook_url` (both environments, staging to a test
contact) and re-run the monitoring play.

During an incident: open an incident on the page within 5 minutes of a confirmed user-facing outage (title: what is
affected, never the cause guess; e.g. "Website property data delayed"); update every 30 minutes; resolve with a
one-line summary. Never name an agency or a client. Maintenance: schedule it 48 h ahead.

## Staged alert test (BLOCKED-HUMAN H4)

Done when (S16-05, manual): each alert fires in a staged test and links to its runbook. Needs staging (H4) with the
monitoring play applied and, for the e-mail/phone legs, H3.

1. Tunnel to staging Prometheus: `ssh -L 9090:<wg_ip>:9090 inmolink@staging-1`.
2. `pnpm ops:alerts list` prints the plan: for every alert its trigger (a chaos drill, `pnpm ops:drill … --staging`
   from chaos-R1.md; a fault set by hand; or *route* — the rule is proven by promtool and only the delivery is staged)
   and how to clear it.
3. Per alert (or per drill, several alerts at once): start the trigger, then
   `pnpm ops:alerts verify --prometheus http://localhost:9090 --alert <name>` — passes when Prometheus reports it
   firing and its runbook annotation resolves to a heading here. Check the e-mail (and the phone call for critical) and
   that the link in it opens the right section.
4. *route* alerts: `pnpm ops:alerts route --alert <name>` prints an `amtool alert add` command; run it on the
   monitoring host (`WG_IP` set) and check the e-mail / phone leg.
5. Clear the trigger; the alert must resolve (resolved e-mail).
6. Record each alert PASS/FAIL with the time to fire in `docs/build/reviews/alerts-R1.md` and in STATUS (S16-05).
