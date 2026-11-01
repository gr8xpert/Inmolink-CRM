import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { docker } from '../../scripts/ops/pitr';

// promtool from the same Prometheus release the monitoring role deploys (infra/ansible/group_vars/all.yml).
const PROMETHEUS_IMAGE = 'prom/prometheus:v3.13.4';
const RULES = join(import.meta.dirname, '..', '..', 'infra', 'monitoring', 'rules');

const promtool = (...args: string[]) =>
  docker(
    ['run', '--rm', '-v', `${RULES}:/rules:ro`, '--entrypoint', 'promtool', PROMETHEUS_IMAGE, ...args],
    {},
    180_000,
    true,
  );

/**
 * mkdtemp makes a 0700 folder; the prom/* images run as `nobody`, so on a Linux Docker host (CI) a bind mount of it
 * is unreadable in the container (`stat …: permission denied`). Docker Desktop ignores the mode; Linux does not.
 */
function worldReadable(dir: string, ...files: string[]): void {
  chmodSync(dir, 0o755);
  for (const f of files) chmodSync(join(dir, f), 0o644);
}

describe('Postgres alerts', () => {
  it('[S0-15] alert rules are valid Prometheus rules', async () => {
    expect(await promtool('check', 'rules', '/rules/postgres.yml')).toMatch(/SUCCESS: \d+ rules found/);
  }, 200_000);

  it('[S0-15] replica lag alert fires when lag > 60 s (and not below), plus streaming, archiving and base-backup alerts', async () => {
    // postgres.test.yml: lag 59 s → no alert; 61 s → pending; held 30 s → PostgresReplicaLagHigh firing.
    expect(await promtool('test', 'rules', '/rules/postgres.test.yml')).toMatch(/SUCCESS/);
  }, 200_000);
});

describe('Search alerts', () => {
  it('[S5-04] search fallback alert rules are valid Prometheus rules', async () => {
    expect(await promtool('check', 'rules', '/rules/search.yml')).toMatch(/SUCCESS: \d+ rules found/);
  }, 200_000);

  it('[S5-04] the fallback alert fires when the breaker stays open 2 min, and on a high fallback share', async () => {
    expect(await promtool('test', 'rules', '/rules/search.test.yml')).toMatch(/SUCCESS/);
  }, 200_000);
});

describe('Import alerts', () => {
  it('[S6-08] import alert rules are valid Prometheus rules', async () => {
    expect(await promtool('check', 'rules', '/rules/imports.yml')).toMatch(/SUCCESS: \d+ rules found/);
  }, 200_000);

  it('[S6-08] [S7-F1] a paused feed (spike, drop or empty feed) alerts at once; a feed run waiting over 15 min in the queue alerts after 5 min', async () => {
    expect(await promtool('test', 'rules', '/rules/imports.test.yml')).toMatch(/SUCCESS/);
  }, 200_000);
});

describe('Website API alerts', () => {
  it('[S7-04] website anti-scraping alert rules are valid Prometheus rules', async () => {
    expect(await promtool('check', 'rules', '/rules/website.yml')).toMatch(/SUCCESS: \d+ rules found/);
  }, 200_000);

  // The test file also holds the S7-F7 case: failing limiter calls are critical after 5 minutes.
  it('[S7-04] [S7-F7] scripted paging and a honeytoken hit alert at once and clear after 15 quiet minutes; failing rate limits page', async () => {
    expect(await promtool('test', 'rules', '/rules/website.test.yml')).toMatch(/SUCCESS/);
  }, 200_000);
});

describe('Queue age alerts', () => {
  it('[S11-review] queue age alert rules are valid Prometheus rules', async () => {
    expect(await promtool('check', 'rules', '/rules/queues.yml')).toMatch(/SUCCESS: \d+ rules found/);
  }, 200_000);

  it('[S11-review] a delivery pool (realtime, email) past a 30 s p95 alerts after 5 min; digests only past 15 min', async () => {
    expect(await promtool('test', 'rules', '/rules/queues.test.yml')).toMatch(/SUCCESS/);
  }, 200_000);
});

describe('Security alerts', () => {
  it('[S12-F8] security alert rules are valid Prometheus rules', async () => {
    expect(await promtool('check', 'rules', '/rules/security.yml')).toMatch(/SUCCESS: \d+ rules found/);
  }, 200_000);

  it('[S12-F8] pending fingerprint rehash near the end of an HMAC rotation window alerts at once and clears at 0', async () => {
    expect(await promtool('test', 'rules', '/rules/security.test.yml')).toMatch(/SUCCESS/);
  }, 200_000);
});

describe('Redis memory alerts', () => {
  it('[S7-04] redis memory alert rules are valid Prometheus rules', async () => {
    expect(await promtool('check', 'rules', '/rules/redis.yml')).toMatch(/SUCCESS: \d+ rules found/);
  }, 200_000);

  // The test file also holds the S7-F7 case: an exporter (or its Redis) not answering is critical after 5 minutes.
  it('[S7-04] [S7-F7] redis-queue past 80 % of maxmemory warns after 10 min, past 95 % is critical after 2 min; a silent exporter is critical', async () => {
    expect(await promtool('test', 'rules', '/rules/redis.test.yml')).toMatch(/SUCCESS/);
  }, 200_000);
});

// S16-05 (operations readiness): SLO burn rates, endpoint probes and certificates, hosts, AI provider, dashboards.
describe('SLO burn-rate alerts', () => {
  it('[S16-05] SLO recording and alert rules are valid Prometheus rules', async () => {
    expect(await promtool('check', 'rules', '/rules/slo.yml')).toMatch(/SUCCESS: \d+ rules found/);
  }, 200_000);
  it('[S16-05] availability, latency and uptime budgets page at 14.4× (1 h + 5 min), warn at 6× (6 h + 30 min); unscraped apps page', async () => {
    expect(await promtool('test', 'rules', '/rules/slo.test.yml')).toMatch(/SUCCESS/);
  }, 200_000);
});

describe('Endpoint and certificate alerts', () => {
  it('[S16-05] endpoint probe alert rules are valid Prometheus rules', async () => {
    expect(await promtool('check', 'rules', '/rules/endpoints.yml')).toMatch(/SUCCESS: \d+ rules found/);
  }, 200_000);
  it('[S16-05] a failing health probe pages after 2 min; certificates warn inside 14 days and page inside 3; a dead prober pages', async () => {
    expect(await promtool('test', 'rules', '/rules/endpoints.test.yml')).toMatch(/SUCCESS/);
  }, 200_000);
});

describe('Host alerts', () => {
  it('[S16-05] host alert rules are valid Prometheus rules', async () => {
    expect(await promtool('check', 'rules', '/rules/node.yml')).toMatch(/SUCCESS: \d+ rules found/);
  }, 200_000);
  it('[S16-05] a host gone pages after 2 min; a real disk over 70 % pages after 15 min (tmpfs and overlays ignored)', async () => {
    expect(await promtool('test', 'rules', '/rules/node.test.yml')).toMatch(/SUCCESS/);
  }, 200_000);
});

describe('AI alerts', () => {
  it('[S16-05] AI alert rules are valid Prometheus rules', async () => {
    expect(await promtool('check', 'rules', '/rules/ai.yml')).toMatch(/SUCCESS: \d+ rules found/);
  }, 200_000);
  it('[S16-05] over half the provider calls failing for 5 min warns; a usage record not written warns at once', async () => {
    expect(await promtool('test', 'rules', '/rules/ai.test.yml')).toMatch(/SUCCESS/);
  }, 200_000);
});

describe('Grafana dashboards', () => {
  it('[S16-05] every dashboard query is valid PromQL (checked by promtool as recording rules)', async () => {
    const dir = join(import.meta.dirname, '..', '..', 'infra', 'grafana', 'dashboards');
    type Panel = { targets?: { expr?: string }[]; panels?: Panel[] };
    const exprs: string[] = [];
    const walk = (panels: Panel[]) => {
      for (const p of panels) {
        for (const t of p.targets ?? []) if (t.expr) exprs.push(t.expr);
        if (p.panels) walk(p.panels);
      }
    };
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      walk((JSON.parse(readFileSync(join(dir, f), 'utf8')) as { panels: Panel[] }).panels);
    }
    expect(exprs.length).toBeGreaterThan(100);
    // Under the repo (node_modules/.cache): Docker Desktop mounts the repo's drive, not every temp folder.
    const cache = join(import.meta.dirname, '..', '..', 'node_modules', '.cache');
    mkdirSync(cache, { recursive: true });
    const tmp = mkdtempSync(join(cache, 'inmolink-dash-'));
    try {
      const rules = {
        groups: [{ name: 'dashboards', rules: exprs.map((expr, i) => ({ record: `dashboard:check_${i}`, expr })) }],
      };
      writeFileSync(join(tmp, 'dashboards.yml'), stringify(rules));
      worldReadable(tmp, 'dashboards.yml');
      const out = await docker(
        [
          'run',
          '--rm',
          '-v',
          `${tmp}:/dash:ro`,
          '--entrypoint',
          'promtool',
          PROMETHEUS_IMAGE,
          'check',
          'rules',
          '/dash/dashboards.yml',
        ],
        {},
        180_000,
        true,
      );
      expect(out).toMatch(new RegExp(`SUCCESS: ${exprs.length} rules found`));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 200_000);
});

describe('Alertmanager config', () => {
  it('[S16-05] the routing, phone receiver and inhibit rules are a valid Alertmanager config (amtool check-config)', async () => {
    const root = join(import.meta.dirname, '..', '..');
    const template = readFileSync(
      join(root, 'infra', 'ansible', 'roles', 'monitoring', 'templates', 'alertmanager.yml.j2'),
      'utf8',
    );
    // Rendered as with every optional receiver set: Jinja blocks kept, values replaced by stand-ins.
    const rendered = template
      .split('\n')
      .filter((l) => !/^\s*\{%.*%\}\s*$/.test(l))
      .join('\n')
      .replace(/\{\{ vault_smtp_url \| urlsplit\('hostname'\) \}\}/g, 'smtp.example.com')
      .replace(/\{\{ vault_smtp_url \| urlsplit\('port'\) \}\}/g, '587')
      .replace(/\{\{ vault_alert_email_from \}\}/g, 'alerts@example.com')
      .replace(/\{\{ alert_email_to \}\}/g, 'ops@example.com')
      .replace(/\{\{ vault_(?:heartbeat|oncall_webhook)_url \}\}/g, 'https://example.com/hook')
      .replace(/\{\{[^}]*\}\}/g, 'x');
    expect(rendered).not.toContain('{%');
    const cache = join(root, 'node_modules', '.cache');
    mkdirSync(cache, { recursive: true });
    const tmp = mkdtempSync(join(cache, 'inmolink-am-'));
    try {
      writeFileSync(join(tmp, 'alertmanager.yml'), rendered);
      worldReadable(tmp, 'alertmanager.yml');
      // Same release as the monitoring role (infra/ansible/group_vars/all.yml `alertmanager_image`).
      const out = await docker(
        [
          'run',
          '--rm',
          '-v',
          `${tmp}:/am:ro`,
          '--entrypoint',
          'amtool',
          'prom/alertmanager:v0.34.1',
          'check-config',
          '/am/alertmanager.yml',
        ],
        {},
        180_000,
        true,
      );
      expect(out).toMatch(/SUCCESS/);
      expect(out).toMatch(/5 inhibit rules/);
      expect(out).toMatch(/3 receivers/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 200_000);
});
