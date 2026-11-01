import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  type FiringAlert,
  githubSlug,
  headingAnchors,
  loadAlertRules,
  loadRecordingRules,
  planTable,
  promqlMetricNames,
  ROOT,
  RULES_DIR,
  routeCommand,
  runbookProblem,
  STAGED_ALERTS,
  verifyFiring,
} from '../../scripts/ops/alerts';

// Operations readiness (S16-05, PLAN §17): alerts, runbooks, dashboards, probes and the status page stay consistent
// with each other and with the metrics the code emits. The rules themselves are unit-tested with promtool in
// tests/ops/alerts.int.test.ts.

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const DASHBOARDS = join(ROOT, 'infra', 'grafana', 'dashboards');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.next' || name === '__tests__') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Attribute keys an instrument's file records (object keys and shorthands; dots → underscores, as Prometheus names them). */
function attributeKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const m of text.matchAll(/['"]([a-z][\w.]*)['"]\s*:/g)) keys.add((m[1] as string).replace(/\./g, '_'));
  for (const m of text.matchAll(/[{,]\s*([a-z][A-Za-z0-9_]*)\s*(?::|(?=[,}]))/g)) keys.add(m[1] as string);
  return keys;
}

/**
 * Prometheus series our OpenTelemetry instruments export (dots → underscores; counters `_total`; histograms
 * `_bucket`/`_count`/`_sum`), each with the attribute keys its source file can record.
 */
function codeMetrics(): Map<string, Set<string>> {
  const files = ['packages', 'apps'].flatMap((top) =>
    readdirSync(join(ROOT, top))
      .map((pkg) => join(ROOT, top, pkg, 'src'))
      .filter((d) => {
        try {
          return statSync(d).isDirectory();
        } catch {
          return false;
        }
      })
      .flatMap((d) => sources(d)),
  );
  const texts = files.map((f) => readFileSync(f, 'utf8'));
  const constants = new Map<string, string>();
  for (const t of texts) {
    for (const m of t.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*'([a-z][\w.]*)'/g)) {
      constants.set(m[1] as string, m[2] as string);
    }
  }
  const metrics = new Map<string, Set<string>>();
  for (const t of texts) {
    for (const m of t.matchAll(
      /\.create(Counter|ObservableCounter|UpDownCounter|ObservableUpDownCounter|Histogram|Gauge|ObservableGauge)(?:<[^>]*>)?\(\s*(?:'([a-z][\w.]*)'|([A-Z][A-Z0-9_]*))/g,
    )) {
      const kind = m[1] as string;
      const otel = m[2] ?? constants.get(m[3] as string);
      if (!otel) throw new Error(`unresolved metric name constant ${m[3]}`);
      const base = otel.replace(/\./g, '_');
      const labels = attributeKeys(t);
      if (kind === 'Counter' || kind === 'ObservableCounter') metrics.set(`${base}_total`, labels);
      else if (kind === 'Histogram') for (const s of ['_bucket', '_count', '_sum']) metrics.set(base + s, labels);
      else metrics.set(base, labels);
    }
  }
  return metrics;
}

/** BullMQ's own OpenTelemetry metrics (bullmq-otel, `enableMetrics`), checked against the installed bullmq. */
function bullmqMetrics(): Map<string, Set<string>> {
  const require = createRequire(join(ROOT, 'packages', 'platform', 'package.json'));
  const enums = join(dirname(require.resolve('bullmq')), 'enums');
  const text = readdirSync(enums)
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(enums, f), 'utf8'))
    .join('\n');
  // Attribute keys BullMQ sets (`bullmq.queue.name` → `bullmq_queue_name`).
  const labels = new Set(
    [...text.matchAll(/'(bullmq\.[a-z_.]+)'|"(bullmq\.[a-z_.]+)"/g)].map((m) =>
      (m[1] ?? m[2] ?? '').replace(/\./g, '_'),
    ),
  );
  const metrics = new Map<string, Set<string>>();
  for (const state of ['completed', 'failed', 'delayed', 'retried', 'waiting', 'waiting_children']) {
    expect(text, `bullmq.jobs.${state}`).toContain(`bullmq.jobs.${state}`);
    metrics.set(`bullmq_jobs_${state}_total`, labels);
  }
  expect(text).toContain('bullmq.job.duration');
  for (const s of ['_bucket', '_count', '_sum']) metrics.set(`bullmq_job_duration${s}`, labels);
  return metrics;
}

/** Labels every scraped series gets (the scrape job, its target, histogram buckets). */
const SCRAPE_LABELS = new Set(['job', 'instance', 'le']);

/** `metric{label=…}` selectors of an expression: each metric with the label names its matchers use. */
function selectorLabels(expr: string): { metric: string; labels: string[] }[] {
  const out: { metric: string; labels: string[] }[] = [];
  for (const m of expr.matchAll(/([a-zA-Z_:][\w:]*)\{([^}]*)\}/g)) {
    const labels = [...(m[2] as string).matchAll(/([a-zA-Z_]\w*)\s*(?:=~|!~|!=|=)/g)].map((x) => x[1] as string);
    out.push({ metric: m[1] as string, labels });
  }
  return out;
}

/** `by (…)` labels of an expression. */
const groupingLabels = (expr: string) =>
  [...expr.matchAll(/\bby\s*\(([^)]*)\)/g)].flatMap((m) =>
    (m[1] as string)
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean),
  );

/**
 * Third-party exporters, by prefix: postgres_exporter (`pg_`), node_exporter (`node_`), redis_exporter (`redis_`),
 * blackbox_exporter (`probe_`), and Prometheus' own series. `inmolink_walg_*` comes from the backup job's textfile
 * (Ansible role postgres, files/inmolink-walg-backup-run) and is checked against that script.
 */
const EXPORTER_PREFIXES = ['pg_', 'node_', 'redis_', 'probe_'];
const PROMETHEUS_SERIES = new Set(['up', 'ALERTS', 'ALERTS_FOR_STATE', 'target_info']);

function knownMetric(name: string, code: Set<string>, recorded: Set<string>, walg: string): boolean {
  if (code.has(name) || recorded.has(name) || PROMETHEUS_SERIES.has(name)) return true;
  if (name.startsWith('inmolink_walg_')) return walg.includes(name);
  if (name.startsWith('inmolink_')) return false;
  return EXPORTER_PREFIXES.some((p) => name.startsWith(p));
}

interface Panel {
  title?: string;
  type: string;
  targets?: { expr?: string }[];
  panels?: Panel[];
}
interface Dashboard {
  uid: string;
  title: string;
  tags?: string[];
  panels: Panel[];
  templating?: { list: { query?: string | { query?: string } }[] };
}

const dashboards = () =>
  readdirSync(DASHBOARDS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, d: JSON.parse(readFileSync(join(DASHBOARDS, f), 'utf8')) as Dashboard }));

function dashboardExprs(d: Dashboard): { where: string; expr: string }[] {
  const out: { where: string; expr: string }[] = [];
  const walk = (panels: Panel[]) => {
    for (const p of panels) {
      for (const t of p.targets ?? []) if (t.expr) out.push({ where: p.title ?? p.type, expr: t.expr });
      if (p.panels) walk(p.panels);
    }
  };
  walk(d.panels);
  for (const v of d.templating?.list ?? []) {
    const q = typeof v.query === 'string' ? v.query : v.query?.query;
    const m = q && /^label_values\((.+),\s*\w+\)$/.exec(q);
    if (m) out.push({ where: 'variable', expr: m[1] as string });
  }
  return out;
}

describe('alerts and runbooks (S16-05)', () => {
  const rules = loadAlertRules();

  it('[S16-05] every alert links to its runbook: an existing docs/runbooks file and heading', () => {
    expect(rules.length).toBeGreaterThan(30);
    const problems = rules
      .map((r) => [r.alert, runbookProblem(r.runbook)] as const)
      .filter(([, p]) => p !== null)
      .map(([a, p]) => `${a}: ${p}`);
    expect(problems).toEqual([]);
    // The clickable link: the configured base (Prometheus external label `runbook_base` = Ansible `runbook_base_url`)
    // + the same repo-relative path.
    for (const r of rules) expect(r.runbookUrl, r.alert).toBe(`{{ $externalLabels.runbook_base }}/${r.runbook}`);
    const prometheus = read('infra', 'ansible', 'roles', 'monitoring', 'templates', 'prometheus.yml.j2');
    expect(prometheus).toContain('runbook_base: "{{ runbook_base_url }}"');
    expect(read('infra', 'ansible', 'group_vars', 'all.yml')).toMatch(/^runbook_base_url: https:\/\/\S+$/m);
    // Severity routes the alert (alertmanager.yml.j2): critical pages, warning mails, none = the heartbeat.
    for (const r of rules) expect(['critical', 'warning', 'none'], r.alert).toContain(r.severity);
    expect(new Set(rules.map((r) => r.alert)).size).toBe(rules.length);
  });

  it('[S16-05] every alert fires in a promtool test case (staged locally)', () => {
    const fired = new Set<string>();
    for (const f of readdirSync(RULES_DIR).filter((n) => n.endsWith('.test.yml'))) {
      const doc = parse(readFileSync(join(RULES_DIR, f), 'utf8')) as {
        tests: {
          external_labels?: Record<string, string>;
          alert_rule_test?: { alertname: string; exp_alerts?: { exp_annotations?: Record<string, string> }[] }[];
        }[];
      };
      for (const t of doc.tests) {
        const base = t.external_labels?.runbook_base;
        for (const a of t.alert_rule_test ?? []) {
          if (!a.exp_alerts?.length) continue;
          fired.add(a.alertname);
          // The firing case checks the runbook link the alert carries.
          const rule = rules.find((r) => r.alert === a.alertname);
          for (const e of a.exp_alerts) {
            expect(e.exp_annotations?.runbook, `${f}: ${a.alertname}`).toBe(rule?.runbook);
            // …and the rendered runbook_url (the test case sets the external label).
            expect(base, `${f}: external_labels.runbook_base`).toMatch(/^https:\/\//);
            expect(e.exp_annotations?.runbook_url, `${f}: ${a.alertname}`).toBe(`${base}/${rule?.runbook}`);
          }
        }
      }
    }
    expect(rules.map((r) => r.alert).filter((a) => !fired.has(a))).toEqual([]);
  });

  it('[S16-05] every alert has a staged trigger for staging and a row in the alert index', () => {
    const names = rules.map((r) => r.alert).sort();
    expect(Object.keys(STAGED_ALERTS).sort()).toEqual(names);
    for (const [name, t] of Object.entries(STAGED_ALERTS)) {
      expect(t.how.length, name).toBeGreaterThan(10);
      expect(t.clear.length, name).toBeGreaterThan(5);
    }
    // Every alert that a drill can trigger names a drill that exists (scripts/ops/chaos.ts).
    const drills = read('scripts', 'ops', 'chaos.ts');
    for (const [name, t] of Object.entries(STAGED_ALERTS).filter(([, t]) => t.kind === 'drill')) {
      const drill = /ops:drill ([a-z-]+)/.exec(t.how)?.[1];
      expect(drill, name).toBeDefined();
      expect(drills, `${name}: drill ${drill}`).toContain(`'${drill}'`);
    }
    expect(planTable(rules)).not.toContain('MISSING');
    const index = read('docs', 'runbooks', 'alerts.md');
    for (const r of rules) {
      const row = index.split('\n').find((l) => l.startsWith(`| \`${r.alert}\` |`));
      expect(row, r.alert).toBeDefined();
      expect(row, r.alert).toContain(`(${(r.runbook as string).replace('docs/runbooks/', '')})`);
      expect(row, r.alert).toContain(`| ${r.severity} |`);
    }
  });

  it('[S16-05] runbooks cover PLAN §17: failover, PITR, reindex, outbox replay, feed storm, AI outage, scraping, cutover, rollback', () => {
    const has = (file: string, anchor: string) => headingAnchors(read('docs', 'runbooks', file)).has(anchor);
    expect(has('failover.md', 'primary-lost-promote-db-2')).toBe(true);
    expect(has('pitr-restore.md', 'restore-drill-and-real-restores')).toBe(true);
    expect(has('search.md', 'reindex')).toBe(true);
    expect(has('queues.md', 'outbox-events-dead-lettered')).toBe(true);
    expect(has('queues.md', 'feed-storm')).toBe(true);
    expect(has('ai-outage.md', 'ai-provider-failing')).toBe(true);
    expect(has('website-api.md', 'scraping-detected')).toBe(true);
    expect(has('cutover.md', 'one-agencys-cutover-run')).toBe(true);
    expect(has('cutover.md', 'one-agencys-rollback-rollback-within-7-days')).toBe(true);
  });

  it('[S16-05] runbook anchors follow GitHub: punctuation dropped, spaces to hyphens, duplicates numbered', () => {
    expect(githubSlug('A feed was paused (`ImportFeedPaused`, S6-08)')).toBe(
      'a-feed-was-paused-importfeedpaused-s6-08',
    );
    expect(githubSlug("One agency's rollback (`rollback`, within 7 days)")).toBe(
      'one-agencys-rollback-rollback-within-7-days',
    );
    expect([...headingAnchors('# T\n## Same\n```\n## not a heading\n```\n## Same\n')]).toEqual(['t', 'same', 'same-1']);
    expect(runbookProblem('docs/runbooks/queues.md#feed-storm')).toBeNull();
    expect(runbookProblem('docs/runbooks/queues.md#no-such-heading')).toMatch(/no heading/);
    expect(runbookProblem('docs/runbooks/nope.md')).toMatch(/no such file/);
    expect(runbookProblem('https://example.com/x')).toMatch(/not a docs\/runbooks/);
    expect(runbookProblem(undefined)).toBe('no runbook annotation');
  });

  it('[S16-05] the staged check passes once Prometheus reports the alert firing with a resolvable runbook', async () => {
    let now = 0;
    const answers: FiringAlert[][] = [
      [],
      [
        {
          labels: { alertname: 'NodeDown' },
          annotations: { runbook: 'docs/runbooks/observability.md#node-down' },
          state: 'pending',
        },
      ],
      [
        { labels: { alertname: 'Other' }, annotations: {}, state: 'firing' },
        {
          labels: { alertname: 'NodeDown', instance: 'staging-1' },
          annotations: { runbook: 'docs/runbooks/observability.md#node-down' },
          state: 'firing',
        },
      ],
    ];
    const urls: string[] = [];
    const fetchFn = async (url: string) => {
      urls.push(url);
      const alerts = answers.shift() ?? [];
      return { ok: true, status: 200, json: async () => ({ status: 'success', data: { alerts } }) };
    };
    const opts = {
      timeoutMs: 600_000,
      pollMs: 15_000,
      fetchFn,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    };
    expect(await verifyFiring('http://localhost:9090', 'NodeDown', opts)).toEqual({
      alert: 'NodeDown',
      ok: true,
      firedAfterSeconds: 30,
      problems: [],
    });
    expect(urls[0]).toBe('http://localhost:9090/api/v1/alerts');

    // Firing, but its runbook link does not resolve: FAIL.
    answers.push([
      {
        labels: { alertname: 'NodeDown' },
        annotations: { runbook: 'docs/runbooks/observability.md#gone' },
        state: 'firing',
      },
    ]);
    const broken = await verifyFiring('http://localhost:9090', 'NodeDown', opts);
    expect(broken.ok).toBe(false);
    expect(broken.problems[0]).toMatch(/no heading with anchor #gone/);

    // Never fires: FAIL at the timeout.
    now = 0;
    const silent = await verifyFiring('http://localhost:9090', 'NodeDown', { ...opts, timeoutMs: 60_000 });
    expect(silent).toMatchObject({ ok: false, problems: ['not firing after 60 s'] });

    // Synthetic copy through Alertmanager for the alerts that cannot be staged (route trigger).
    const backup = loadAlertRules().find((r) => r.alert === 'BaseBackupNeverReported');
    expect(STAGED_ALERTS.BaseBackupNeverReported?.kind).toBe('route');
    const cmd = routeCommand(backup as NonNullable<typeof backup>, 'http://10.20.0.11:9093');
    expect(cmd).toContain("'alertname=BaseBackupNeverReported'");
    expect(cmd).toContain("'severity=critical'");
    expect(cmd).toContain("'runbook=docs/runbooks/pitr-restore.md#base-backup-missing'");
    expect(cmd).toContain('--alertmanager.url=http://10.20.0.11:9093');
  });

  it('[S16-05] critical alerts page (on-call webhook) as well as e-mail; the heartbeat keeps its own route', () => {
    const am = read('infra', 'ansible', 'roles', 'monitoring', 'templates', 'alertmanager.yml.j2');
    const phone = am.indexOf('receiver: ops-phone');
    const email = am.indexOf('receiver: ops-email\n      repeat_interval: 1h');
    expect(phone).toBeGreaterThan(0);
    expect(email).toBeGreaterThan(phone);
    expect(am.slice(phone, email)).toContain('continue: true');
    expect(am).toContain('url: "{{ vault_oncall_webhook_url }}"');
    for (const env of ['production', 'staging']) {
      expect(read('infra', 'ansible', 'inventories', env, 'group_vars', 'all', 'vault.example.yml')).toContain(
        'vault_oncall_webhook_url:',
      );
    }
  });

  it('[S16-05] one cause, one notification: inhibitions mute the alerts a root cause implies; grouped by service', () => {
    const am = parse(
      read('infra', 'ansible', 'roles', 'monitoring', 'templates', 'alertmanager.yml.j2')
        .split('\n')
        .filter((l) => !l.includes('{%'))
        .join('\n')
        .replace(/\{\{[^}]*\}\}/g, 'x'),
    ) as {
      route: { group_by: string[] };
      inhibit_rules: { source_matchers: string[]; target_matchers: string[]; equal: string[] }[];
    };
    expect(am.route.group_by).toEqual(['alertname', 'service', 'instance']);
    const rule = (source: string) =>
      am.inhibit_rules.filter((r) => r.source_matchers.includes(`alertname="${source}"`));
    const names = new Set(rules.map((r) => r.alert));
    for (const r of am.inhibit_rules) {
      for (const m of [...r.source_matchers, ...r.target_matchers]) {
        const alert = /^alertname=~?"(.+)"$/.exec(m)?.[1];
        if (!alert) continue;
        // Every matcher names alerts that exist (a renamed alert would silently stop inhibiting).
        expect(
          [...names].some((n) => new RegExp(`^(?:${alert})$`).test(n)),
          m,
        ).toBe(true);
      }
    }
    expect(rule('NodeDown')).toEqual([
      { source_matchers: ['alertname="NodeDown"'], target_matchers: ['alertname="EndpointDown"'], equal: ['host'] },
    ]);
    expect(rule('EndpointDown').map((r) => [r.target_matchers, r.equal])).toEqual([
      [['alertname="AppMetricsDown"'], ['service']],
      [['alertname=~"SloErrorBudgetBurn(Fast|Slow)"', 'slo="uptime"'], ['service']],
    ]);
    expect(rule('SloErrorBudgetBurnFast').map((r) => [r.target_matchers, r.equal])).toEqual([
      [['alertname="SloErrorBudgetBurnSlow"'], ['service', 'slo']],
    ]);
    expect(rule('CertificateExpiryCritical').map((r) => [r.target_matchers, r.equal])).toEqual([
      [['alertname="CertificateExpiringSoon"'], ['instance']],
    ]);
    // The `equal` labels are on both sides: EndpointDown carries host and service, AppMetricsDown service, NodeDown host.
    const expr = (a: string) => rules.find((r) => r.alert === a)?.expr ?? '';
    expect(expr('EndpointDown')).toContain('max by (service, instance, host)');
    expect(expr('AppMetricsDown')).toContain('"service", "$1", "job", "(.*)"');
    expect(read('infra', 'ansible', 'roles', 'monitoring', 'templates', 'prometheus.yml.j2')).toContain(
      'labels: { instance: {{ h }}, host: {{ h }} }',
    );
  });

  it('[S16-05] every alert rule file is in the Ansible copy loop (and nothing else)', () => {
    const tasks = parse(read('infra', 'ansible', 'roles', 'monitoring', 'tasks', 'main.yml')) as {
      name: string;
      loop?: string[];
    }[];
    const copy = tasks.find((t) => t.name.startsWith('Alert rules'));
    const files = readdirSync(RULES_DIR).filter((f) => f.endsWith('.yml') && !f.endsWith('.test.yml'));
    expect([...(copy?.loop ?? [])].sort()).toEqual(files.sort());
  });
});

describe('dashboards (S16-05)', () => {
  const instruments = new Map([...codeMetrics(), ...bullmqMetrics()]);
  const code = new Set(instruments.keys());
  const recorded = new Set(loadRecordingRules().map((r) => r.record));
  const walg = read('infra', 'ansible', 'roles', 'postgres', 'files', 'inmolink-walg-backup-run');
  const known = (name: string) => knownMetric(name, code, recorded, walg);

  it('[S16-05] the metric catalog is read from the code (OTel instruments → Prometheus names)', () => {
    for (const m of [
      'http_server_request_duration_bucket',
      'inmolink_queue_wait_seconds_bucket',
      'inmolink_import_paused_total',
      'inmolink_import_oldest_queued_seconds',
      'inmolink_search_breaker_open',
      'inmolink_ai_provider_calls_total',
      'inmolink_network_match_round_ms_bucket',
    ]) {
      expect(code, m).toContain(m);
    }
    expect(
      promqlMetricNames(
        'sum by (le, pool) (rate(inmolink_queue_wait_seconds_bucket{pool=~"$pool", le="0.15"}[5m])) > 0.5',
      ),
    ).toEqual(['inmolink_queue_wait_seconds_bucket']);
    expect(
      promqlMetricNames(
        'slo:sli_error:ratio_rate1h / on (service, slo) group_left () (1 - slo:objective:ratio) and time() - up',
      ),
    ).toEqual(['slo:objective:ratio', 'slo:sli_error:ratio_rate1h', 'up']);
  });

  it('[S16-05] dashboards are valid, uniquely identified, and every query reads a metric the code or an exporter emits', () => {
    const all = dashboards();
    expect(all.length).toBeGreaterThanOrEqual(10);
    expect(new Set(all.map((x) => x.d.uid)).size).toBe(all.length);
    const unknown: string[] = [];
    for (const { file, d } of all) {
      expect(d.title, file).toMatch(/^Inmolink · /);
      expect(d.tags, file).toContain('inmolink');
      const exprs = dashboardExprs(d);
      expect(exprs.length, file).toBeGreaterThan(0);
      for (const { where, expr } of exprs) {
        const names = promqlMetricNames(expr);
        expect(names.length, `${file} › ${where}: ${expr}`).toBeGreaterThan(0);
        for (const n of names) if (!known(n)) unknown.push(`${file} › ${where}: ${n}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('[S16-05] every alert rule reads metrics the code or an exporter emits (no alert on a renamed metric)', () => {
    const unknown: string[] = [];
    for (const r of [...loadAlertRules(), ...loadRecordingRules().map((x) => ({ alert: x.record, expr: x.expr }))]) {
      for (const n of promqlMetricNames(r.expr)) if (!known(n)) unknown.push(`${r.alert}: ${n}`);
    }
    expect(unknown).toEqual([]);
  });

  it('[S16-05] every label a rule or dashboard filters or groups on exists on its instrument', () => {
    const exprs = [
      ...loadAlertRules().map((r) => ({ where: r.alert, expr: r.expr })),
      ...loadRecordingRules().map((r) => ({ where: r.record, expr: r.expr })),
      ...dashboards().flatMap(({ file, d }) =>
        dashboardExprs(d).map((e) => ({ where: `${file} › ${e.where}`, expr: e.expr })),
      ),
    ];
    const problems: string[] = [];
    for (const { where, expr } of exprs) {
      for (const { metric, labels } of selectorLabels(expr)) {
        const known = instruments.get(metric);
        if (!known) continue;
        for (const l of labels) if (!SCRAPE_LABELS.has(l) && !known.has(l)) problems.push(`${where}: ${metric}{${l}}`);
      }
      // `by (…)` over instruments only: the label is one they record (or one label_replace makes in the expression).
      const names = promqlMetricNames(expr);
      const used = names.filter((n) => instruments.has(n));
      if (used.length === 0 || used.length !== names.length) continue;
      const made = new Set([...expr.matchAll(/"(\w+)",\s*"\$1"/g)].map((m) => m[1] as string));
      const recorded = new Set(used.flatMap((n) => [...(instruments.get(n) ?? [])]));
      for (const l of groupingLabels(expr)) {
        if (!SCRAPE_LABELS.has(l) && !recorded.has(l) && !made.has(l)) {
          problems.push(`${where}: by (${l}) on ${used.join(', ')}`);
        }
      }
    }
    // Template variables: label_values(metric, label).
    for (const { file, d } of dashboards()) {
      for (const v of d.templating?.list ?? []) {
        const q = typeof v.query === 'string' ? v.query : v.query?.query;
        const m = q && /^label_values\(([a-zA-Z_:][\w:]*)[^,]*,\s*(\w+)\)$/.exec(q);
        if (!m) continue;
        const known = instruments.get(m[1] as string);
        if (known && !SCRAPE_LABELS.has(m[2] as string) && !known.has(m[2] as string)) problems.push(`${file}: ${q}`);
      }
    }
    expect(problems).toEqual([]);
    // The catalog is specific: what an instrument records, not every label anywhere.
    expect(instruments.get('inmolink_queue_wait_seconds_bucket')).toContain('pool');
    expect(instruments.get('inmolink_queue_wait_seconds_bucket')).not.toContain('outcome');
    expect(instruments.get('http_server_request_duration_count')).toContain('http_response_status_code');
    expect(instruments.get('inmolink_ai_provider_calls_total')).toContain('outcome');
    expect(instruments.get('bullmq_jobs_completed_total')).toContain('bullmq_queue_name');
  });

  it('[S16-05] every service with a /metrics port has its own dashboard', () => {
    const apps = readdirSync(join(ROOT, 'apps')).filter((a) => {
      try {
        return /_METRICS_PORT/.test(read('apps', a, 'src', 'config.ts'));
      } catch {
        return false;
      }
    });
    expect(apps.sort()).toEqual(['api', 'feed-api', 'realtime', 'worker']);
    const all = dashboards();
    for (const app of apps) {
      const d = all.find((x) => x.d.tags?.includes(`service:${app}`));
      expect(d, app).toBeDefined();
      // Its golden signals read the service's own scrape job.
      const exprs = dashboardExprs((d as { d: Dashboard }).d).map((e) => e.expr);
      expect(
        exprs.some((e) => e.includes(`job="${app}"`)),
        app,
      ).toBe(true);
    }
  });
});

describe('endpoint probes and the status page (S16-05)', () => {
  const kamal = (f: string) =>
    parse(read('infra', 'kamal', f)) as { proxy?: { host?: string; healthcheck?: { path?: string } } };
  const probes = (env: string) =>
    (
      parse(read('infra', 'ansible', 'inventories', env, 'group_vars', 'all', 'main.yml')) as {
        endpoint_probes: { service: string; url: string; host: string }[];
      }
    ).endpoint_probes;

  it('[S16-05] every app behind the proxy is probed at its public host and health path, per environment', () => {
    for (const env of ['production', 'staging']) {
      const expected = readdirSync(join(ROOT, 'infra', 'kamal'))
        .filter((f) => /^[a-z-]+\.yml$/.test(f))
        .map((f) => f.replace('.yml', ''))
        .flatMap((app) => {
          const host = kamal(`${app}.${env}.yml`).proxy?.host;
          const path = kamal(`${app}.yml`).proxy?.healthcheck?.path;
          return host && path ? [{ service: app, url: `https://${host}${path}` }] : [];
        })
        .sort((a, b) => a.service.localeCompare(b.service));
      expect(expected.length, env).toBe(5);
      expect(
        probes(env)
          .map(({ service, url }) => ({ service, url }))
          .sort((a, b) => a.service.localeCompare(b.service)),
        env,
      ).toEqual(expected);
      // `host`: an app host of the inventory (NodeDown of that host inhibits the probe's EndpointDown; the origin probe
      // dials its WireGuard address).
      const inventory = parse(read('infra', 'ansible', 'inventories', env, 'hosts.yml')) as {
        all: { children: { app: { hosts: Record<string, unknown> } } };
      };
      const appHosts = Object.keys(inventory.all.children.app.hosts);
      for (const p of probes(env)) expect(appHosts, `${env} ${p.service}`).toContain(p.host);
    }
    const prometheus = read('infra', 'ansible', 'roles', 'monitoring', 'templates', 'prometheus.yml.j2');
    expect(prometheus).toContain('job_name: blackbox');
    // Origin probes: same paths at the app host, SNI/Host from the public host (blackbox `hostname` parameter).
    expect(prometheus).toContain('job_name: blackbox-origin');
    expect(prometheus).toContain('target_label: __param_hostname');
    expect(read('infra', 'ansible', 'roles', 'monitoring', 'templates', 'blackbox.yml.j2')).toContain('http_origin:');
    expect(read('infra', 'ansible', 'roles', 'monitoring', 'tasks', 'main.yml')).toContain(
      '--storage.tsdb.retention.time=35d',
    );
    expect(prometheus).toContain('{% for p in endpoint_probes %}');
    expect(read('infra', 'ansible', 'roles', 'monitoring', 'tasks', 'main.yml')).toContain('blackbox_exporter_image');
    expect(read('infra', 'ansible', 'group_vars', 'all.yml')).toMatch(
      /blackbox_exporter_image: prom\/blackbox-exporter:v[\d.]+@sha256:[0-9a-f]{64}/,
    );
  });

  it('[S16-05] the public status page monitors every production endpoint and nothing else', () => {
    const page = parse(read('infra', 'monitoring', 'status-page.yml')) as {
      url: string;
      components: { name: string; service: string; url: string }[];
    };
    expect(page.url).toBe('https://status.inmolink.es');
    const prod = probes('production').map(({ service, url }) => ({ service, url }));
    expect(
      page.components
        .map((c) => ({ service: c.service, url: c.url }))
        .sort((a, b) => a.service.localeCompare(b.service)),
    ).toEqual([...prod].sort((a, b) => a.service.localeCompare(b.service)));
    // Agency-facing names only: no internal host or service names on the public page.
    for (const c of page.components)
      expect(c.name, c.service).not.toMatch(/api-|feed-api|realtime|worker|postgres|redis/i);
  });
});
