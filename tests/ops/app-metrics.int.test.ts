import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadAlertRules } from '../../scripts/ops/alerts';
import { docker } from '../../scripts/ops/pitr';

// S16-F6: app metrics reach Prometheus across Kamal's rolling deploys. Locally: the app host's scraper
// (infra/ansible/roles/app_metrics/templates/app-metrics.yml.j2) on a throwaway Docker network, the monitoring host's
// `app-metrics` federation job (roles/monitoring/templates/prometheus.yml.j2) in a second Prometheus, both rendered from
// the templates. The real api, feed-api, realtime and worker boot from main.ts on this machine; each app's Kamal alias
// is a forwarder container on the network (to the app's metrics port on the Docker host), so the scraper's DNS
// discovery runs as rendered — Prometheus asks Docker's DNS, which never serves `--add-host` entries (on Linux,
// `host.docker.internal` exists only in /etc/hosts). The media role's alias names two stand-in containers at once — a
// rolling deploy's old and new.

const ROOT = join(import.meta.dirname, '..', '..');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
// The monitoring role's Prometheus, pinned by digest (infra/ansible/group_vars/all.yml `prometheus_image`): the scraper's too.
const PROMETHEUS_IMAGE = String(
  (parse(readFileSync(join(ROOT, 'infra', 'ansible', 'group_vars', 'all.yml'), 'utf8')) as { prometheus_image: string })
    .prometheus_image,
);
// Forwards an alias's container port to the app on the Docker host (socat 1.8.0.3, pinned by digest).
const SOCAT_IMAGE = 'alpine/socat:1.8.0.3@sha256:beb4a68d9e4fe6b0f21ea774a0fde6c31f580dde6368939ed70100c5385b015e';
const LABEL = 'inmolink.test=s16-f6';
const RUN = randomBytes(3).toString('hex');
const NET = `inmolink-s16f6-${RUN}`;
const SCRAPER = `inmolink-s16f6-scraper-${RUN}`;
const CENTRAL = `inmolink-s16f6-central-${RUN}`;
const RELEASE = `s16f6-${RUN}`;
const HOST = 'app-test';

// Fixed ports below 32768 (tests/apps/boot.int.test.ts uses 311x0–311x3), the template's container port per app.
const APPS = [
  { name: 'api', port: 31130, portVar: 'API_PORT', metrics: 31140, metricsVar: 'API_METRICS_PORT', container: 9464 },
  {
    name: 'feed-api',
    port: 31131,
    portVar: 'FEED_API_PORT',
    metrics: 31141,
    metricsVar: 'FEED_API_METRICS_PORT',
    container: 9465,
  },
  {
    name: 'realtime',
    port: 31132,
    portVar: 'REALTIME_PORT',
    metrics: 31142,
    metricsVar: 'REALTIME_METRICS_PORT',
    container: 9466,
  },
  {
    name: 'worker',
    port: 31133,
    portVar: 'WORKER_HEALTH_PORT',
    metrics: 31143,
    metricsVar: 'WORKER_METRICS_PORT',
    container: 9467,
    // `maintenance` has no jobs yet; never `outbox` here — it would claim the queue suite's events.
    extra: { WORKER_POOLS: 'maintenance' },
  },
] as const;
const alias = (app: string) => `inmolink-${app}-metrics`;

function stackEnv(): Record<string, string> {
  const file = [join(ROOT, '.env.test'), join(ROOT, '.env.test.example')].find((f) => existsSync(f));
  if (!file) throw new Error('no .env.test(.example)');
  const env = parseEnv(readFileSync(file, 'utf8'));
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
}

/** The scraper's config as Ansible renders it, intervals at 2 s. */
function renderScraper(): string {
  const text = readFileSync(
    join(ROOT, 'infra', 'ansible', 'roles', 'app_metrics', 'templates', 'app-metrics.yml.j2'),
    'utf8',
  )
    .replace('{{ ansible_managed }}', 'rendered by tests/ops/app-metrics.int.test.ts')
    .replace(/\{\{ inventory_hostname \}\}/g, HOST);
  for (const app of APPS) {
    expect(text, app.name).toContain(`{ names: [${alias(app.name)}], type: A, port: ${app.container},`);
  }
  expect(text).not.toContain('{{');
  return text.replace(/\b15s\b/g, '2s').replace('scrape_timeout: 10s', 'scrape_timeout: 2s');
}

/** The monitoring host's federation job, cut from prometheus.yml.j2 and rendered for one app host. */
function renderCentral(): string {
  const template = readFileSync(
    join(ROOT, 'infra', 'ansible', 'roles', 'monitoring', 'templates', 'prometheus.yml.j2'),
    'utf8',
  );
  const start = template.indexOf('  - job_name: app-metrics');
  const end = template.indexOf('\n\n', start);
  expect(start).toBeGreaterThan(0);
  const job = template
    .slice(start, end)
    .split('\n')
    .filter((l) => !/^\s*\{%.*%\}\s*$/.test(l))
    .join('\n')
    .replace('{{ hostvars[a].wg_ip }}:{{ app_metrics_port }}', `${SCRAPER}:9090`)
    .replace(/\{\{ a \}\}/g, HOST);
  expect(job).not.toMatch(/\{\{|\{%/);
  return `global:\n  scrape_interval: 2s\n  evaluation_interval: 2s\nscrape_configs:\n${job}\n`;
}

type Series = { metric: Record<string, string>; value: [number, string] };

let central = '';
const children: ChildProcess[] = [];
const outputs = new Map<string, () => string>();
let tmp = '';

async function cleanup(): Promise<void> {
  const ids = (await docker(['ps', '-aq', '--filter', `label=${LABEL}`])).split(/\r?\n/).filter(Boolean);
  if (ids.length > 0) await docker(['rm', '-f', ...ids]);
  const nets = (await docker(['network', 'ls', '-q', '--filter', `label=${LABEL}`])).split(/\r?\n/).filter(Boolean);
  if (nets.length > 0) await docker(['network', 'rm', ...nets]);
}

async function query(q: string): Promise<Series[]> {
  const res = await fetch(`${central}/api/v1/query?query=${encodeURIComponent(q)}`);
  const body = (await res.json()) as { status: string; error?: string; data: { result: Series[] } };
  if (body.status !== 'success') throw new Error(`${q}: ${body.error}`);
  return body.data.result;
}

async function eventually<T>(what: string, fn: () => Promise<T | undefined>, ms = 90_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  const logs = [...outputs.entries()].map(([n, o]) => `--- ${n}\n${o().slice(-1500)}`).join('\n');
  // The scraper's view (no published port): each target's health and last error, for a failure on CI.
  const targets = await docker(['exec', SCRAPER, 'wget', '-qO-', 'http://127.0.0.1:9090/api/v1/targets']).catch(
    (err: unknown) => String(err),
  );
  throw new Error(`${what}: not in ${ms / 1000} s (${String(last ?? '')})\n${logs}\n--- scraper targets\n${targets}`);
}

/** An app's Kamal alias on the network, listening on the template's port, forwarding to the app on this machine. */
const startForwarder = (app: (typeof APPS)[number]) =>
  docker([
    'run',
    '-d',
    '--name',
    `inmolink-s16f6-fwd-${app.name}-${RUN}`,
    '--label',
    LABEL,
    '--network',
    NET,
    '--network-alias',
    alias(app.name),
    // Linux: the Docker host is host-gateway (docker0), in /etc/hosts only; Docker Desktop also answers it by DNS.
    '--add-host',
    'host.docker.internal:host-gateway',
    SOCAT_IMAGE,
    `TCP-LISTEN:${app.container},fork,reuseaddr`,
    // IPv4: Docker Desktop's host-gateway entry is IPv6 (not routed to Windows); its DNS gives the IPv4 address.
    `TCP4:host.docker.internal:${app.metrics}`,
  ]);

const standIn = (n: number) => `inmolink-s16f6-media-${n}-${RUN}`;
const startStandIn = (n: number) =>
  docker([
    'run',
    '-d',
    '--name',
    standIn(n),
    '--label',
    LABEL,
    '--network',
    NET,
    // What infra/kamal/worker.yml's media role sets (`options.network-alias`), listening on the role's metrics port.
    '--network-alias',
    'inmolink-worker-media-metrics',
    PROMETHEUS_IMAGE,
    '--config.file=/etc/prometheus/prometheus.yml',
    '--web.listen-address=:9467',
  ]);

beforeAll(async () => {
  await cleanup();
  // Under the repo (node_modules/.cache): Docker Desktop mounts the repo's drive, not every temp folder.
  const cache = join(ROOT, 'node_modules', '.cache');
  mkdirSync(cache, { recursive: true });
  tmp = mkdtempSync(join(cache, 'inmolink-s16f6-'));
  // The prom/prometheus image runs as `nobody`: on a Linux Docker host the mounted folders must be world-readable.
  for (const [dir, config] of [
    ['scraper', renderScraper()],
    ['central', renderCentral()],
  ] as const) {
    mkdirSync(join(tmp, dir));
    chmodSync(join(tmp, dir), 0o755);
    writeFileSync(join(tmp, dir, 'prometheus.yml'), config);
    chmodSync(join(tmp, dir, 'prometheus.yml'), 0o644);
  }

  await docker(['network', 'create', '--label', LABEL, NET]);
  for (const app of APPS) await startForwarder(app);
  await startStandIn(1);
  await startStandIn(2);
  const prometheus = (name: string, dir: string, extra: string[]) =>
    docker([
      'run',
      '-d',
      '--name',
      name,
      '--label',
      LABEL,
      '--network',
      NET,
      ...extra,
      '-v',
      `${join(tmp, dir)}:/etc/inmolink:ro`,
      PROMETHEUS_IMAGE,
      '--config.file=/etc/inmolink/prometheus.yml',
      '--storage.tsdb.path=/prometheus',
      '--web.listen-address=:9090',
    ]);
  await prometheus(SCRAPER, 'scraper', []);
  await prometheus(CENTRAL, 'central', ['-p', '127.0.0.1::9090']);
  const port = (await docker(['port', CENTRAL, '9090/tcp'])).split(/\r?\n/)[0]?.split(':').at(-1);
  central = `http://127.0.0.1:${port}`;

  const env = stackEnv();
  for (const app of APPS) {
    const args = [
      TSX,
      '--conditions=@inmolink/source',
      '--import',
      '@inmolink/platform/telemetry/register',
      'src/main.ts',
    ];
    const child = spawn(process.execPath, args, {
      cwd: join(ROOT, 'apps', app.name),
      env: {
        ...process.env,
        ...env,
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
        RELEASE,
        [app.portVar]: String(app.port),
        [app.metricsVar]: String(app.metrics),
        // As in the Kamal configs: every interface (the forwarders reach it from the Docker network).
        METRICS_HOST: '0.0.0.0',
        ...('extra' in app ? app.extra : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let out = '';
    child.stdout?.on('data', (d) => {
      out += d;
    });
    child.stderr?.on('data', (d) => {
      out += d;
    });
    outputs.set(app.name, () => `${child.exitCode === null ? '' : `exited ${child.exitCode}\n`}${out}`);
  }
}, 300_000);

afterAll(async () => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  try {
    await cleanup();
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}, 120_000);

const appMetricsDown = () => {
  const rule = loadAlertRules().find((r) => r.alert === 'AppMetricsDown');
  if (!rule) throw new Error('AppMetricsDown missing');
  return rule.expr;
};

describe('app metrics reach Prometheus (S16-F6)', () => {
  it('[S16-F6] the scraper runs the digest-pinned Prometheus of the monitoring role', () => {
    expect(PROMETHEUS_IMAGE).toMatch(/^prom\/prometheus:v[\d.]+@sha256:[0-9a-f]{64}$/);
  });

  it('[S16-F6] api, feed-api, realtime and worker are up targets on the federating Prometheus and AppMetricsDown resolves', async () => {
    // Traffic, so the request metric exists (the readiness route: excluded from the SLOs, recorded all the same).
    await eventually('api ready', async () => {
      const res = await fetch(`http://127.0.0.1:${APPS[0].port}/readyz`, { signal: AbortSignal.timeout(3_000) });
      return res.status === 200 ? true : undefined;
    });
    for (const app of APPS) {
      const up = await eventually(`up{job="${app.name}"} == 1 federated`, async () => {
        const r = await query(`up{job="${app.name}", kamal_role!="media"} == 1`);
        return r.length === 1 ? r[0] : undefined;
      });
      // Per-instance identity: the job, the scraped container, the app host — labels kept by the federation.
      // (`instance`: the address Docker's DNS gave for the alias, on the template's port.)
      expect(up.metric).toMatchObject({ job: app.name, host: HOST });
      expect(up.metric.instance).toMatch(new RegExp(`^[0-9.]+:${app.container}$`));
      if (app.name === 'worker') expect(up.metric.kamal_role).toBe('workers');
      // The version, from the app's OpenTelemetry resource.
      const info = await eventually(`target_info{job="${app.name}"}`, async () => {
        const r = await query(`target_info{job="${app.name}"}`);
        return r[0];
      });
      expect(info.metric).toMatchObject({ service_name: app.name, service_version: RELEASE });
    }
    // The alert's expression: no app left unscraped.
    await eventually('AppMetricsDown resolved', async () =>
      (await query(appMetricsDown())).length === 0 ? true : undefined,
    );
    // The S16-05 dashboards read these labels: each service dashboard's target count is 1 per running process.
    const dir = join(ROOT, 'infra', 'grafana', 'dashboards');
    for (const app of APPS) {
      const file = readdirSync(dir).find((f) => f === `service-${app.name}.json`);
      expect(file, app.name).toBeDefined();
      const text = readFileSync(join(dir, file as string), 'utf8');
      expect(text).toContain(`sum(up{job=\\"${app.name}\\"})`);
    }
    for (const app of APPS.filter((a) => a.name !== 'worker')) {
      const [s] = await query(`sum(up{job="${app.name}"})`);
      expect(Number(s?.value[1]), app.name).toBe(1);
    }
    await eventually('http_server_request_duration_count{job="api"}', async () => {
      const r = await query('http_server_request_duration_count{job="api"}');
      return r.length > 0 ? r : undefined;
    });
  }, 300_000);

  it('[S16-F6] two containers of a role at once (rolling deploy) are two targets; the series continue when the old one goes', async () => {
    await eventually('both media containers scraped', async () => {
      const r = await query('up{job="worker", kamal_role="media"} == 1');
      return r.length === 2 ? r : undefined;
    });
    // Kamal stops the old container once the new one is healthy.
    await docker(['rm', '-f', standIn(1)]);
    const deadline = Date.now() + 60_000;
    let targets = 2;
    while (Date.now() < deadline && targets !== 1) {
      // Never a gap: some media container is up on every evaluation, so the worker job never counts as unscraped.
      const [alive] = await query('max(up{job="worker", kamal_role="media"})');
      expect(Number(alive?.value[1])).toBe(1);
      expect((await query(appMetricsDown())).filter((s) => s.metric.job === 'worker')).toEqual([]);
      targets = (await query('up{job="worker", kamal_role="media"}')).length;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    expect(targets).toBe(1);
  }, 180_000);

  it('[S16-F6] no per-tenant label reaches Prometheus', async () => {
    const res = await fetch(
      `${central}/api/v1/labels?${new URLSearchParams({ 'match[]': '{job=~"api|feed-api|realtime|worker"}' })}`,
    );
    const labels = ((await res.json()) as { data: string[] }).data;
    expect(labels).toEqual(expect.arrayContaining(['job', 'instance', 'host']));
    expect(labels.filter((l) => /agency|tenant|site|user|contact|listing/i.test(l))).toEqual([]);
  });
});
