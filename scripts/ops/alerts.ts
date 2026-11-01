// pnpm ops:alerts list                                       the staged-firing plan (every alert, how to trigger it)
// pnpm ops:alerts verify --prometheus <url> --alert <name>   waits until the alert fires and checks its runbook link
//                       [--alert <name> …] [--timeout <s>]  (repeat --alert; default timeout: the rule's `for` + 15 min)
// pnpm ops:alerts route --alert <name>                       prints the amtool command that sends a synthetic copy of
//                                                             the alert through Alertmanager (routing, e-mail, phone)
//
// Operations readiness (S16-05, PLAN §17). Every alert in infra/monitoring/rules has a staged trigger below: a chaos
// drill (`pnpm ops:drill … --staging`, S16-02), a fault injected by hand on staging, or — when the condition cannot be
// staged safely (26 h without a backup, a certificate about to expire) — a synthetic alert through Alertmanager (the
// rule itself is proven by its promtool test). Procedure: docs/runbooks/observability.md › Staged alert test
// (BLOCKED-HUMAN H4: staging does not exist yet).
//
// Prometheus is reached over WireGuard or an SSH tunnel (`ssh -L 9090:<wg_ip>:9090 inmolink@<monitoring host>`).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';

export const ROOT = join(import.meta.dirname, '..', '..');
export const RULES_DIR = join(ROOT, 'infra', 'monitoring', 'rules');

export interface AlertRule {
  file: string;
  group: string;
  alert: string;
  expr: string;
  for?: string;
  severity: string;
  summary?: string;
  runbook?: string;
  /** `{{ $externalLabels.runbook_base }}/<runbook>`: the clickable link in notifications (base: `runbook_base_url`). */
  runbookUrl?: string;
}

interface RuleFile {
  groups: {
    name: string;
    rules: {
      alert?: string;
      record?: string;
      expr: string;
      for?: string;
      labels?: Record<string, string>;
      annotations?: Record<string, string>;
    }[];
  }[];
}

const ruleFiles = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.yml') && !f.endsWith('.test.yml'))
    .sort();

/** Every alerting rule of infra/monitoring/rules (the files the Ansible role deploys). */
export function loadAlertRules(dir = RULES_DIR): AlertRule[] {
  const out: AlertRule[] = [];
  for (const file of ruleFiles(dir)) {
    const doc = parse(readFileSync(join(dir, file), 'utf8')) as RuleFile;
    for (const g of doc.groups) {
      for (const r of g.rules) {
        if (!r.alert) continue;
        out.push({
          file,
          group: g.name,
          alert: r.alert,
          expr: r.expr,
          for: r.for,
          severity: r.labels?.severity ?? '',
          summary: r.annotations?.summary,
          runbook: r.annotations?.runbook,
          runbookUrl: r.annotations?.runbook_url,
        });
      }
    }
  }
  return out;
}

/** Recording rules: `{ record, expr }` of every group. */
export function loadRecordingRules(dir = RULES_DIR): { record: string; expr: string }[] {
  const out: { record: string; expr: string }[] = [];
  for (const file of ruleFiles(dir)) {
    const doc = parse(readFileSync(join(dir, file), 'utf8')) as RuleFile;
    for (const g of doc.groups) for (const r of g.rules) if (r.record) out.push({ record: r.record, expr: r.expr });
  }
  return out;
}

/** The anchor GitHub gives a Markdown heading: lower case, punctuation dropped, spaces → hyphens. */
export function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Anchors of a Markdown file's headings (duplicates get GitHub's `-1`, `-2` suffixes). */
export function headingAnchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const m = !fenced && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = githubSlug(m[1] as string);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** Why a `runbook` annotation does not resolve (repo-relative `docs/runbooks/<file>.md[#anchor]`), or null. */
export function runbookProblem(runbook: string | undefined, root = ROOT): string | null {
  if (!runbook) return 'no runbook annotation';
  const [path, anchor] = runbook.split('#', 2) as [string, string | undefined];
  if (!/^docs\/runbooks\/[a-z0-9-]+\.md$/.test(path)) return `${runbook}: not a docs/runbooks/*.md path`;
  const file = join(root, path);
  if (!existsSync(file)) return `${path}: no such file`;
  if (anchor !== undefined && !headingAnchors(readFileSync(file, 'utf8')).has(anchor)) {
    return `${runbook}: no heading with anchor #${anchor}`;
  }
  return null;
}

const PROMQL_WORDS = new Set([
  // functions
  ...'abs absent absent_over_time avg_over_time ceil changes clamp clamp_max clamp_min count_over_time day_of_month day_of_week delta deriv exp floor histogram_quantile holt_winters idelta increase irate label_join label_replace last_over_time ln log2 log10 max_over_time min_over_time predict_linear present_over_time quantile_over_time rate resets round scalar sort sort_desc sqrt stddev_over_time sum_over_time time timestamp vector humanize'.split(
    ' ',
  ),
  // aggregations, modifiers, operators
  ...'sum min max avg count stddev stdvar topk bottomk quantile count_values group by without on ignoring group_left group_right bool and or unless offset inf nan'.split(
    ' ',
  ),
]);

/**
 * Metric names a PromQL expression (or Grafana target) reads. Strings, label matchers, range/offset durations and
 * `by (…)` / `on (…)` label lists are dropped first; what is left that is not a function, keyword or number is a name.
 * Grafana's `$__rate_interval` / `$var` macros are stripped too.
 */
export function promqlMetricNames(expr: string): string[] {
  const stripped = expr
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ' ')
    .replace(/\$\{?\w+\}?/g, ' ');
  const names = new Set<string>();
  for (const m of stripped.matchAll(/(?<![\w.])[a-zA-Z_:][\w:]*(?![\w(]|\s*\()/g)) {
    const word = m[0];
    if (PROMQL_WORDS.has(word.toLowerCase())) continue;
    if (/^\d/.test(word)) continue;
    names.add(word);
  }
  return [...names].sort();
}

/** How a staged test makes an alert fire on staging. */
export interface StagedTrigger {
  /** `drill`: a chaos drill (S16-02) · `inject`: a fault set by hand on staging · `route`: synthetic, via Alertmanager. */
  kind: 'drill' | 'inject' | 'route';
  how: string;
  /** How the condition is undone (the alert must resolve too). */
  clear: string;
}

const ROUTE_ONLY = (why: string): StagedTrigger => ({
  kind: 'route',
  how: `${why} — the rule is proven by its promtool test; \`pnpm ops:alerts route --alert <name>\` proves the delivery`,
  clear: 'amtool alert expires after 10 minutes',
});

/**
 * The staged-firing plan: one trigger per alert. tests/workspace/monitoring.test.ts fails when an alert has none.
 * Hosts: staging-1 (apps, Postgres, redis-queue, monitoring — infra/ansible/inventories/staging). The replication alerts
 * need a standby: run them with the postgres-primary drill's throwaway pair or on production's db-2 before go-live.
 */
export const STAGED_ALERTS: Record<string, StagedTrigger> = {
  Watchdog: {
    kind: 'inject',
    how: 'always firing: the heartbeat service shows pings arriving every minute',
    clear: 'stop Alertmanager 6 min: the heartbeat service pages (dead-man switch), then start it',
  },
  // postgres.yml
  PostgresReplicaLagHigh: {
    kind: 'inject',
    how: 'on the standby: `SELECT pg_wal_replay_pause();` while the write ticker runs (ops:drill postgres-primary --staging keeps one); lag passes 60 s',
    clear: '`SELECT pg_wal_replay_resume();`',
  },
  PostgresReplicaBehindBytes: {
    kind: 'inject',
    how: 'on the standby host: `tc qdisc add dev wg0 root netem rate 1mbit` and write > 1 GiB on the primary (`pnpm db:seed:scale --staging --agencies=50`)',
    clear: '`tc qdisc del dev wg0 root`',
  },
  PostgresReplicaNotStreaming: {
    kind: 'drill',
    how: '`pnpm ops:drill postgres-primary --staging --confirm …` (standby stopped/promoted: the slot goes inactive) — or `docker stop postgres` on the standby for 3 min',
    clear: '`docker start postgres` on the standby (or re-seed it after the drill: failover.md)',
  },
  PostgresSlotRetainingWal: {
    kind: 'inject',
    how: "create a throwaway slot on the primary (`SELECT pg_create_physical_replication_slot('staged_test', true);`) and write > 20 GiB of WAL (scale seed)",
    clear: "`SELECT pg_drop_replication_slot('staged_test');`",
  },
  PostgresDown: {
    kind: 'drill',
    how: '`pnpm ops:drill postgres-primary --staging --confirm …` (primary killed)',
    clear: 'the drill restores the primary; or `docker start postgres`',
  },
  WalArchivingFailing: {
    kind: 'inject',
    how: 'point WAL-G at a bucket it may not write (`WALG_S3_PREFIX` of a read-only token in /etc/inmolink/postgres/walg.env), `SELECT pg_switch_wal();`',
    clear: 'restore walg.env, `SELECT pg_switch_wal();` (pitr-restore.md › Archiving failing)',
  },
  WalArchivingStale: {
    kind: 'inject',
    how: 'same as WalArchivingFailing, held 20 minutes (no segment archived)',
    clear: 'restore walg.env',
  },
  BaseBackupMissing: ROUTE_ONLY('26 h without a successful backup cannot be staged in a test window'),
  BaseBackupNeverReported: ROUTE_ONLY('26 h with no backup report cannot be staged in a test window'),
  // queues.yml / imports.yml
  DeliveryQueueAgeHigh: {
    kind: 'inject',
    how: 'stop the worker role that runs `email` (`kamal app stop -c infra/kamal/worker.yml -d staging --roles workers`) while sign-in mails / notifications are produced for 10 min',
    clear: '`kamal app boot … --roles workers`; the queue drains',
  },
  QueueAgeHigh: {
    kind: 'inject',
    how: 'stop the workers role for 35 min while the scheduler enqueues digests and maintenance jobs',
    clear: 'boot the workers role',
  },
  ImportQueueWaitHigh: {
    kind: 'inject',
    how: 'stop the workers role and let the import scheduler queue feed runs for 25 min (scale seed has feed connections)',
    clear: 'boot the workers role',
  },
  ImportFeedPaused: {
    kind: 'inject',
    how: 'serve an empty feed for a staging connection (`--feed-base-url` of the scale seed pointed at an empty file) and run its import',
    clear: 'resume the connection in the dashboard; the alert clears after 15 min',
  },
  // search.yml
  SearchFallbackActive: {
    kind: 'drill',
    how: '`pnpm ops:drill search --staging --confirm --search-host ssh://… --origin-listings-url …` (Meilisearch stopped > 2 min)',
    clear: 'the drill restarts Meilisearch',
  },
  SearchFallbackShareHigh: {
    kind: 'drill',
    how: '`pnpm ops:drill search --staging --confirm … --outage-seconds 900` under the k6 `degraded` profile (S7-F9)',
    clear: 'drill end',
  },
  SearchBreakerFlapping: {
    kind: 'inject',
    how: 'on the search host: `tc qdisc add dev eth0 root netem delay 80ms` (above SEARCH_SLOW_MS) for 30 s every 5 min, under website load',
    clear: '`tc qdisc del dev eth0 root`',
  },
  WebsiteChangesHeld: {
    kind: 'inject',
    how: 'psql on the primary: `BEGIN; SELECT txid_current();` and leave the session open 20 min',
    clear: '`ROLLBACK;`',
  },
  // website.yml / redis.yml / security.yml
  WebsiteScrapingDetected: {
    kind: 'inject',
    how: "page a staging site's full inventory with its secret key past the hourly paging limit (k6 `scrape` scenario, tests/load)",
    clear: 'clears 15 min after the run',
  },
  WebsiteHoneytokenHit: {
    kind: 'inject',
    how: 'request the detail of a honeytoken reference served on a deep page during the scrape run',
    clear: 'clears after 15 min',
  },
  WebsiteEdgePurgeFailing: {
    kind: 'inject',
    how: 'set an invalid CLOUDFLARE_API_TOKEN on the staging worker, change a listing (a purge is queued)',
    clear: 'restore the token, redeploy the worker',
  },
  RateLimitFailing: {
    kind: 'drill',
    how: '`CHAOS_REDIS_QUEUE_URL=<tunnel> pnpm ops:drill redis-queue --staging --confirm …` with `--outage-seconds 420` (limiter calls fail > 5 min)',
    clear: 'drill end',
  },
  RedisMemoryHigh: {
    kind: 'inject',
    how: '`redis-cli CONFIG SET maxmemory <used × 1.15>` on staging redis-queue for 15 min',
    clear: '`CONFIG SET maxmemory <redis_queue_maxmemory>`',
  },
  RedisMemoryCritical: {
    kind: 'inject',
    how: '`CONFIG SET maxmemory <used × 1.02>` for 5 min (writes may fail: no deploys meanwhile)',
    clear: '`CONFIG SET maxmemory <redis_queue_maxmemory>`',
  },
  RedisExporterDown: {
    kind: 'inject',
    how: '`docker stop redis-exporter` on the db primary for 7 min',
    clear: '`docker start redis-exporter`',
  },
  HmacRotationRehashPending: {
    kind: 'inject',
    how: 'staging only: set HMAC_KEY_PREVIOUS_UNTIL to now + 12 h with a fresh HMAC_KEY (runbook steps 1–3) and wait for the next 15-min check',
    clear: 'finish the rehash (runbook step 9) or unset the window',
  },
  // slo.yml / endpoints.yml / node.yml / ai.yml (S16-05)
  SloErrorBudgetBurnFast: {
    kind: 'drill',
    how: '`pnpm ops:drill feed-origin --staging --confirm --outage-seconds 600 …` under the k6 website mix: origin 5xx > 14.4× budget (feed-api; for api stop its Postgres pool: postgres-primary drill)',
    clear: 'drill end; clears within 5 min',
  },
  SloErrorBudgetBurnSlow: {
    kind: 'inject',
    how: 'the feed-api latency budget: on the app host `tc qdisc add dev eth0 root netem delay 200ms` towards Postgres for 45 min under the k6 mix',
    clear: '`tc qdisc del dev eth0 root`',
  },
  AppMetricsDown: {
    kind: 'inject',
    how: '`kamal app stop -c infra/kamal/realtime.yml -d staging` for 12 min (or deploy with REALTIME_METRICS_PORT 0)',
    clear: '`kamal app boot -c infra/kamal/realtime.yml -d staging`',
  },
  EndpointDown: {
    kind: 'drill',
    how: '`pnpm ops:drill feed-origin --staging --confirm --outage-seconds 240 …` (feed-api containers stopped: /readyz fails)',
    clear: 'drill end',
  },
  EndpointProbesMissing: {
    kind: 'inject',
    how: '`docker stop blackbox-exporter` on the monitoring host for 12 min',
    clear: '`docker start blackbox-exporter`',
  },
  CertificateExpiringSoon: ROUTE_ONLY(
    'a certificate inside 14 days of expiry cannot be staged (Cloudflare renews edge certificates)',
  ),
  CertificateExpiryCritical: ROUTE_ONLY('a certificate inside 3 days of expiry cannot be staged'),
  NodeDown: {
    kind: 'inject',
    how: '`sudo systemctl stop node_exporter` on staging-1 for 3 min',
    clear: '`sudo systemctl start node_exporter`',
  },
  DiskUsageHigh: {
    kind: 'inject',
    how: '`sudo fallocate -l <size to pass 70 %> /srv/staged-alert.fill` on staging-1, held 17 min',
    clear: '`sudo rm /srv/staged-alert.fill`',
  },
  AiProviderFailing: {
    kind: 'inject',
    how: 'on the staging app host block egress to the AI provider (`sudo iptables -I DOCKER-USER -p tcp --dport 443 -d <provider IPs> -j DROP`) during 15 min of AI calls (> 20 per 10 min): timeouts open the breaker',
    clear: '`sudo iptables -D DOCKER-USER -p tcp --dport 443 -d <provider IPs> -j DROP`',
  },
  AiProviderRejecting: {
    kind: 'drill',
    how: '`pnpm ops:drill ai-provider --staging --confirm …` (invalid AI key on feed-api + worker: every call 401) with > 20 AI calls in 10 min',
    clear: 'restore the key, redeploy',
  },
  AiUsageRecordFailing: {
    kind: 'inject',
    how: 'on staging redis-queue: `ACL SETUSER feed_ai off` for 2 min while one website AI search runs (feed-api cannot queue its usage row)',
    clear: 're-run the Ansible redis_queue role (restores the ACL), then replay the logged row: ai-outage.md',
  },
};

/** Durations like `30s`, `5m`, `1h`, `26h` → seconds. */
export function durationSeconds(d: string | undefined): number {
  if (!d) return 0;
  let total = 0;
  for (const m of d.matchAll(/(\d+)(ms|s|m|h|d)/g)) {
    const n = Number(m[1]);
    total += m[2] === 'ms' ? n / 1000 : m[2] === 's' ? n : m[2] === 'm' ? n * 60 : m[2] === 'h' ? n * 3600 : n * 86400;
  }
  return total;
}

export interface FiringAlert {
  labels: Record<string, string>;
  annotations: Record<string, string>;
  state: 'pending' | 'firing' | 'inactive';
  activeAt?: string;
}

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The alert's instances as Prometheus reports them (`GET /api/v1/alerts`). */
export async function currentAlerts(
  prometheusUrl: string,
  alert: string,
  fetchFn: Fetch = fetch,
): Promise<FiringAlert[]> {
  const res = await fetchFn(new URL('/api/v1/alerts', prometheusUrl).href);
  if (!res.ok) throw new Error(`Prometheus /api/v1/alerts answered ${res.status}`);
  const body = (await res.json()) as { status: string; data?: { alerts?: FiringAlert[] } };
  if (body.status !== 'success') throw new Error('Prometheus /api/v1/alerts: status not success');
  return (body.data?.alerts ?? []).filter((a) => a.labels.alertname === alert);
}

export interface VerifyResult {
  alert: string;
  ok: boolean;
  firedAfterSeconds?: number;
  problems: string[];
}

/**
 * Polls until `alert` fires (state `firing`), then checks that every firing instance carries a runbook annotation that
 * resolves to a heading in docs/runbooks. Times out with `ok: false`.
 */
export async function verifyFiring(
  prometheusUrl: string,
  alert: string,
  o: {
    timeoutMs: number;
    pollMs?: number;
    fetchFn?: Fetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    root?: string;
  },
): Promise<VerifyResult> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const started = now();
  for (;;) {
    const firing = (await currentAlerts(prometheusUrl, alert, o.fetchFn)).filter((a) => a.state === 'firing');
    if (firing.length > 0) {
      const problems = firing
        .map((a) => runbookProblem(a.annotations.runbook, o.root))
        .filter((p): p is string => p !== null);
      return { alert, ok: problems.length === 0, firedAfterSeconds: Math.round((now() - started) / 1000), problems };
    }
    if (now() - started >= o.timeoutMs) {
      return { alert, ok: false, problems: [`not firing after ${Math.round(o.timeoutMs / 1000)} s`] };
    }
    await sleep(o.pollMs ?? 15_000);
  }
}

/** The amtool command (run on the monitoring host) that sends a synthetic copy of the alert through Alertmanager. */
export function routeCommand(rule: AlertRule, alertmanagerUrl = 'http://$WG_IP:9093'): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    'docker exec alertmanager amtool alert add',
    q(`alertname=${rule.alert}`),
    q(`severity=${rule.severity}`),
    q('staged=true'),
    `--annotation=${q(`summary=STAGED TEST (S16-05): ${rule.alert}`)}`,
    `--annotation=${q(`runbook=${rule.runbook ?? ''}`)}`,
    '--end=$(date -u -d "+10 min" +%Y-%m-%dT%H:%M:%SZ)',
    `--alertmanager.url=${alertmanagerUrl}`,
  ].join(' ');
}

/** The staged-firing plan as a Markdown table (`pnpm ops:alerts list`). */
export function planTable(rules = loadAlertRules()): string {
  const rows = rules.map((r) => {
    const t = STAGED_ALERTS[r.alert];
    return `| ${r.alert} | ${r.severity} | ${t?.kind ?? 'MISSING'} | ${t?.how ?? ''} | ${t?.clear ?? ''} | ${r.runbook ?? ''} |`;
  });
  return [
    '| Alert | Severity | Trigger | How (staging) | Clear | Runbook |',
    '|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      prometheus: { type: 'string' },
      alert: { type: 'string', multiple: true },
      timeout: { type: 'string' },
      alertmanager: { type: 'string' },
    },
  });
  const rules = loadAlertRules();
  const byName = new Map(rules.map((r) => [r.alert, r]));
  const pick = () => {
    const names = values.alert ?? [];
    if (names.length === 0) throw new Error('--alert <name> is required');
    return names.map((n) => {
      const r = byName.get(n);
      if (!r) throw new Error(`unknown alert ${n}`);
      return r;
    });
  };
  switch (positionals[0]) {
    case 'list':
      console.log(planTable(rules));
      return;
    case 'route':
      for (const r of pick()) console.log(routeCommand(r, values.alertmanager));
      return;
    case 'verify': {
      if (!values.prometheus) throw new Error('--prometheus <url> is required (tunnel to the monitoring host)');
      let failed = 0;
      for (const r of pick()) {
        const timeoutMs = values.timeout ? Number(values.timeout) * 1000 : (durationSeconds(r.for) + 900) * 1000;
        const res = await verifyFiring(values.prometheus, r.alert, { timeoutMs });
        console.log(
          `${res.ok ? 'PASS' : 'FAIL'} ${r.alert}${res.firedAfterSeconds !== undefined ? ` (fired after ${res.firedAfterSeconds} s)` : ''}${res.problems.length ? ` — ${res.problems.join('; ')}` : ''}`,
        );
        if (!res.ok) failed++;
      }
      process.exitCode = failed ? 1 : 0;
      return;
    }
    default:
      throw new Error('usage: pnpm ops:alerts list | route --alert <name> | verify --prometheus <url> --alert <name>');
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
