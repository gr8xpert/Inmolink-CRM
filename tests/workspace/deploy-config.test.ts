import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { groupHosts, loadInventory } from '../../scripts/ops/inventory';
import { chooseBackup, pgTimestamp } from '../../scripts/ops/pitr';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const yaml = <T>(...p: string[]) => parse(read(...p)) as T;

interface KamalRole {
  hosts?: string[];
  proxy?: boolean;
}
interface Kamal {
  service: string;
  image: string;
  registry: { server: string };
  servers: Record<string, KamalRole>;
  primary_role?: string;
  proxy?: { app_port: number; healthcheck: { path: string }; host?: string };
  drain_timeout?: number;
  env: { clear: Record<string, string>; secret: string[] };
  accessories?: Record<string, { host?: string; image?: string }>;
}

const APPS = readdirSync(join(ROOT, 'apps'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== 'wp-plugin')
  .map((d) => d.name);
const DESTS = ['staging', 'production'] as const;
const kamal = (app: string) => yaml<Kamal>('infra', 'kamal', `${app}.yml`);
const dest = (app: string, d: string) => yaml<Partial<Kamal>>('infra', 'kamal', `${app}.${d}.yml`);
const ciImages = yaml<{ jobs: { images: { strategy: { matrix: { app: string[] } } } } }>(
  '.github',
  'workflows',
  'ci.yml',
);

describe('Kamal deploy config', () => {
  it('[S0-15] every image CI builds has a Kamal config with staging and production destinations', () => {
    expect(ciImages.jobs.images.strategy.matrix.app.sort()).toEqual([...APPS].sort());
    for (const app of APPS) {
      const k = kamal(app);
      expect(k.service).toBe(`inmolink-${app}`);
      // CI pushes ghcr.io/<owner>/inmolink-<app>:<git sha>; Kamal deploys --version <git sha> of that image.
      expect(`${k.registry.server}/${k.image}`).toBe(`ghcr.io/gr8xpert/inmolink-${app}`);
      for (const d of DESTS) {
        const role = Object.keys(k.servers)[0] as string;
        expect(dest(app, d).servers?.[role]?.hosts?.length, `${app}.${d}`).toBeGreaterThan(0);
        expect(dest(app, d).env?.clear?.DEPLOY_ENV).toBe(d);
      }
    }
  });

  it('[S0-15] zero-downtime: every proxied app is health-checked on a route it serves, on the port it listens on', () => {
    for (const app of APPS) {
      const k = kamal(app);
      if (app === 'worker') {
        expect(k.servers.workers?.proxy).toBe(false);
        continue;
      }
      const proxy = k.proxy as NonNullable<Kamal['proxy']>;
      const portVar = Object.entries(k.env.clear).find(([key]) => /(^|_)PORT$/.test(key) && !key.includes('METRICS'));
      expect(Number(portVar?.[1]), app).toBe(proxy.app_port);
      expect(k.env.clear.HOST).toBe('0.0.0.0');
      if (proxy.healthcheck.path === '/healthz') {
        // Next apps: an App Router route handler.
        expect(read('apps', app, 'src', 'app', 'healthz', 'route.ts')).toContain('export');
      } else {
        expect(proxy.healthcheck.path).toBe('/readyz');
        expect(read('packages', 'platform', 'src', 'server', 'health.ts')).toContain("'/readyz'");
      }
      // The old container keeps serving (readyz failing) until kamal-proxy has drained it.
      expect(Number(k.env.clear.SHUTDOWN_DRAIN_DELAY_MS) / 1000).toBeLessThanOrEqual(k.drain_timeout ?? 30);
      for (const d of DESTS) expect(dest(app, d).proxy?.host, `${app}.${d}`).toMatch(/inmolink\.es$/);
    }
  });

  it('[S0-15] secrets stay out of clear env; every referenced secret is declared in .kamal/secrets.example', () => {
    const declared = new Set([...read('.kamal', 'secrets.example').matchAll(/^([A-Z0-9_]+)=\$\1$/gm)].map((m) => m[1]));
    for (const app of APPS) {
      const k = kamal(app);
      for (const key of Object.keys(k.env.clear)) {
        expect(key, `${app}: ${key} looks secret`).not.toMatch(
          /PASSWORD|SECRET|PRIVATE|DATABASE_URL|HMAC|ENCRYPTION|_KEY$/,
        );
      }
      for (const s of k.env.secret) expect(declared, `${app}: ${s}`).toContain(s);
      // S0-04: HTTP apps never get the BYPASSRLS role, and no runtime gets the owner role.
      expect(k.env.secret).not.toContain('DATABASE_URL_APP_OWNER');
      expect(k.env.secret).not.toContain('DATABASE_URL_ADMIN');
      if (k.env.clear.APP_ROLE === 'http') expect(k.env.secret, app).not.toContain('DATABASE_URL_APP_SYSTEM');
    }
    expect(declared).toContain('KAMAL_REGISTRY_PASSWORD');
  });
});

describe('edge and access', () => {
  const groupVars = yaml<{ cloudflare_ips: string[]; postgres_image: string } & Record<string, unknown>>(
    'infra',
    'ansible',
    'group_vars',
    'all.yml',
  );

  it('[S0-15] behind Cloudflare, apps trust exactly kamal-proxy + Cloudflare (the origin lock allows the same ranges)', () => {
    expect(groupVars.cloudflare_ips.length).toBeGreaterThan(10);
    for (const app of APPS.filter((a) => a !== 'worker')) {
      const trusted = kamal(app).env.clear.TRUST_PROXY?.split(',') ?? [];
      expect(trusted[0], app).toBe('172.16.0.0/12'); // the `kamal` Docker network
      expect(trusted.slice(1).sort(), app).toEqual([...groupVars.cloudflare_ips].sort());
    }
    expect(read('infra', 'ansible', 'roles', 'docker', 'templates', 'inmolink-origin-lock.j2')).toContain(
      'cloudflare_ips',
    );
  });

  it('[S0-15] CI keys never reach db hosts; images are pinned by digest', () => {
    const base = read('infra', 'ansible', 'roles', 'base', 'tasks', 'main.yml');
    expect(base).toContain("vault_deploy_ssh_keys if 'app' in group_names else []");
    expect(base).toContain("vault_drill_ssh_keys if 'drill' in group_names else []");
    for (const [key, value] of Object.entries(groupVars)) {
      if (key.endsWith('_image') && key !== 'postgres_image')
        expect(String(value), key).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
    for (const acc of Object.values(kamal('api').accessories ?? {}) as { image?: string }[]) {
      expect(acc.image).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
    expect(read('infra', 'docker', 'postgres', 'Dockerfile')).toMatch(/^FROM \S+@sha256:[0-9a-f]{64}$/m);
  });
});

describe('Ansible inventory and images', () => {
  it('[S0-15] production: standby on its own server, monitoring outside the primary, staging single-host', () => {
    const prod = loadInventory('production');
    const names = (g: string) => groupHosts(prod, g).map((h) => h.name);
    expect(names('db_primary')).toEqual(['db-1']);
    expect(names('db_replica')).toEqual(['db-2']);
    expect(names('app')).toEqual(['app-1']);
    expect(names('monitoring')).not.toContain('db-1');
    expect(groupHosts(prod, 'db_replica')[0]?.vars.replication_slot).toBe('db_2');
    const wg = groupHosts(prod, 'all').map((h) => h.vars.wg_ip);
    expect(new Set(wg).size).toBe(wg.length);

    const staging = loadInventory('staging');
    expect(groupHosts(staging, 'db_primary')[0]?.vars.ansible_host).toBe('203.0.113.50');
    expect(groupHosts(staging, 'db_replica')).toEqual([]);
  });

  it('[S0-15] production Postgres runs the same image (WAL-G + ops scripts) as local dev and the tests', () => {
    const composeTag = read('docker-compose.yml').match(/image: inmolink\/postgres:(\S+)/)?.[1];
    expect(composeTag).toMatch(/walg/);
    expect(read('infra', 'ansible', 'group_vars', 'all.yml')).toContain(
      `postgres_image: ghcr.io/gr8xpert/inmolink-postgres:${composeTag}`,
    );
  });
});

describe('restore drill helpers', () => {
  const backups = [
    {
      backup_name: 'base_000000010000000000000003',
      start_time: '2026-10-09T02:30:00Z',
      finish_time: '2026-10-09T02:41:00Z',
    },
    {
      backup_name: 'base_000000010000000000000009',
      start_time: '2026-10-10T02:30:00Z',
      finish_time: '2026-10-10T02:44:00Z',
    },
    {
      backup_name: 'base_00000001000000000000000F',
      start_time: '2026-10-11T02:30:00Z',
      finish_time: '2026-10-11T02:39:00Z',
    },
  ];

  it('[S0-15] PITR starts from the newest base backup that finished before the target', () => {
    expect(chooseBackup(backups, new Date('2026-10-10T12:00:00Z')).backup_name).toBe('base_000000010000000000000009');
    expect(chooseBackup(backups, new Date('2026-10-10T02:43:00Z')).backup_name).toBe('base_000000010000000000000003');
    expect(chooseBackup(backups).backup_name).toBe('base_00000001000000000000000F');
    expect(() => chooseBackup(backups, new Date('2026-10-09T02:40:00Z'))).toThrow(/no base backup finished before/);
    expect(() => chooseBackup([])).toThrow(/no base backups/);
  });

  it('[S0-15] recovery target uses the timestamp form Postgres accepts', () => {
    expect(pgTimestamp(new Date('2026-10-11T10:00:00.123Z'))).toBe('2026-10-11 10:00:00.123+00');
  });
});
