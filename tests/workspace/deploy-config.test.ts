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
  options?: Record<string, unknown>;
  env?: { clear?: Record<string, string>; secret?: string[] };
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
/** Kamal `ENV:SECRET` aliases: the variable the container sees, and the secret its value comes from. */
const envName = (entry: string) => entry.split(':')[0] as string;
const secretName = (entry: string) => entry.split(':').at(-1) as string;
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

  it('[S3-F4] the media container gets no SMTP, encryption, HMAC or app_system credentials, and a read-only filesystem', () => {
    const k = kamal('worker');
    const media = k.servers.media as KamalRole;
    expect(media.env?.clear?.WORKER_POOLS).toBe('media');
    const seen = [
      ...Object.keys(k.env.clear),
      ...k.env.secret,
      ...Object.keys(media.env?.clear ?? {}),
      ...(media.env?.secret ?? []),
      ...DESTS.flatMap((d) => Object.keys(dest('worker', d).env?.clear ?? {})),
      ...DESTS.flatMap((d) => dest('worker', d).env?.secret ?? []),
    ];
    for (const key of seen) {
      expect(key, `media container gets ${key}`).not.toMatch(
        /^(SMTP_|EMAIL_|RESEND_|ENCRYPTION_|HMAC_KEY$|DATABASE_URL_APP_(SYSTEM|USER|OWNER|AUTH|STAFF|PUBLIC)$|DATABASE_URL_ADMIN$)/,
      );
    }
    expect(media.env?.secret).toContain('DATABASE_URL_APP_MEDIA');
    expect(media.options?.['read-only']).toBe(true);
  });

  it('[S5-CI] the media container sizes its memory itself: V8 heap within the cgroup cap, a fixed glibc mmap threshold', () => {
    const media = kamal('worker').servers.media as KamalRole;
    const clear = media.env?.clear ?? {};
    const oldSpace = Number(/--max-old-space-size=(\d+)/.exec(clear.NODE_OPTIONS ?? '')?.[1]);
    const semiSpace = Number(/--max-semi-space-size=(\d+)/.exec(clear.NODE_OPTIONS ?? '')?.[1]);
    expect(oldSpace).toBeGreaterThan(0);
    expect(semiSpace).toBeGreaterThan(0);
    // V8's whole heap (old space + 3 semi-spaces) stays well inside the container's hard cap
    expect(oldSpace + 3 * semiSpace).toBeLessThan(Number.parseInt(String(media.options?.memory), 10) * 0.6);
    expect(Number(clear.MALLOC_MMAP_THRESHOLD_)).toBeGreaterThan(0);
  });

  it('[S6-F5] the workers role sizes V8 and glibc like the media role (the feed-import RSS test runs with them)', () => {
    const k = kamal('worker');
    const workers = (k.servers.workers as KamalRole).env?.clear ?? {};
    const media = (k.servers.media as KamalRole).env?.clear ?? {};
    expect(workers.NODE_OPTIONS).toBe(media.NODE_OPTIONS);
    expect(workers.MALLOC_MMAP_THRESHOLD_).toBe(media.MALLOC_MMAP_THRESHOLD_);
  });

  it('[S3-F7] the media container gets its own Redis user and R2 token, and no cache', () => {
    const k = kamal('worker');
    const media = k.servers.media as KamalRole;
    const workers = k.servers.workers as KamalRole;
    const shared = [...k.env.secret, ...DESTS.flatMap((d) => dest('worker', d).env?.secret ?? [])].map(envName);
    for (const key of ['REDIS_QUEUE_URL', 'REDIS_CACHE_URL', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
      expect(shared, `${key} is shared by both roles`).not.toContain(key);
      expect(workers.env?.secret, key).toContain(key);
    }
    expect(media.env?.secret).toEqual(
      expect.arrayContaining([
        'REDIS_QUEUE_URL:REDIS_QUEUE_URL_MEDIA',
        'S3_ACCESS_KEY_ID:S3_MEDIA_ACCESS_KEY_ID',
        'S3_SECRET_ACCESS_KEY:S3_MEDIA_SECRET_ACCESS_KEY',
      ]),
    );
    expect((media.env?.secret ?? []).map(envName)).not.toContain('REDIS_CACHE_URL');
    // The Ansible config declares the `media` ACL user the URL logs in as.
    expect(read('infra', 'ansible', 'roles', 'redis_queue', 'tasks', 'main.yml')).toContain(
      'user media on >{{ vault_redis_media_password }} {{ redis_media_acl }}',
    );
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
      const roleSecrets = Object.values(k.servers).flatMap((r) => r.env?.secret ?? []);
      for (const s of [...k.env.secret, ...roleSecrets].map(secretName)) expect(declared, `${app}: ${s}`).toContain(s);
      // S0-04: HTTP apps never get the BYPASSRLS role, and no runtime gets the owner role.
      expect(k.env.secret).not.toContain('DATABASE_URL_APP_OWNER');
      expect(k.env.secret).not.toContain('DATABASE_URL_ADMIN');
      if (k.env.clear.APP_ROLE === 'http') expect(k.env.secret, app).not.toContain('DATABASE_URL_APP_SYSTEM');
    }
    expect(declared).toContain('KAMAL_REGISTRY_PASSWORD');
  });
});

describe('edge and access', () => {
  const groupVars = yaml<
    { cloudflare_ips: string[]; kamal_network_subnet: string; postgres_image: string } & Record<string, unknown>
  >('infra', 'ansible', 'group_vars', 'all.yml');

  it('[S0-15] every env variable an app requires is set by its Kamal config (clear or secret)', async () => {
    const appEnv: Record<string, () => Promise<Record<string, { safeParse(v: unknown): { success: boolean } }>>> = {
      api: async () => (await import('../../apps/api/src/config')).apiEnv,
      'feed-api': async () => (await import('../../apps/feed-api/src/config')).feedApiEnv,
      realtime: async () => (await import('../../apps/realtime/src/config')).realtimeEnv,
      worker: async () => (await import('../../apps/worker/src/config')).workerEnv,
      web: async () => (await import('../../apps/web/src/server/env')).webEnv,
    };
    // Set by the app itself (web forces APP_ROLE=http).
    const SET_IN_CODE: Record<string, string[]> = { web: ['APP_ROLE'] };
    const missing: string[] = [];
    const { workerEnvFor } = await import('../../apps/worker/src/config');
    for (const [app, load] of Object.entries(appEnv)) {
      // Worker roles (S3-F4) each validate what their own pools need: shared env plus the role's own.
      const roles: [string, KamalRole | undefined, Record<string, { safeParse(v: unknown): { success: boolean } }>][] =
        app === 'worker'
          ? Object.entries(kamal(app).servers).map(([name, role]) => [
              name,
              role,
              workerEnvFor((role.env?.clear?.WORKER_POOLS ?? 'all').split(',') as never),
            ])
          : [['', undefined, await load()]];
      for (const [roleName, role, schema] of roles) {
        for (const d of DESTS) {
          const provided = new Set([
            ...Object.keys(kamal(app).env.clear),
            ...Object.keys(dest(app, d).env?.clear ?? {}),
            ...kamal(app).env.secret.map(envName),
            ...Object.keys(role?.env?.clear ?? {}),
            ...(role?.env?.secret ?? []).map(envName),
            ...(SET_IN_CODE[app] ?? []),
          ]);
          for (const [key, field] of Object.entries(schema)) {
            if (!provided.has(key) && !field.safeParse(undefined).success)
              missing.push(`${app}${roleName}.${d}: ${key}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  }, 180_000); // imports five apps' config modules (core, platform): 38 s alone, more under a full verify (S5-F3)

  it('[S0-15] behind Cloudflare, apps trust exactly kamal-proxy + Cloudflare (the origin lock allows the same ranges)', () => {
    expect(groupVars.cloudflare_ips.length).toBeGreaterThan(10);
    for (const app of APPS.filter((a) => a !== 'worker')) {
      const trusted = kamal(app).env.clear.TRUST_PROXY?.split(',') ?? [];
      expect(trusted[0], app).toBe(groupVars.kamal_network_subnet); // the `kamal` Docker network
      expect(trusted.slice(1).sort(), app).toEqual([...groupVars.cloudflare_ips].sort());
    }
    expect(read('infra', 'ansible', 'roles', 'docker', 'templates', 'inmolink-origin-lock.j2')).toContain(
      'cloudflare_ips',
    );
  });

  it('[S1-F5] the proxy hop is the fixed kamal subnet; the Workers range passes the origin lock but is not trusted', () => {
    expect(read('infra', 'ansible', 'roles', 'docker', 'templates', 'inmolink-origin-lock.j2')).toContain(
      'cloudflare_workers_ips',
    );
    expect(groupVars.kamal_network_subnet).toMatch(/^10\.\d+\.\d+\.0\/24$/);
    expect(read('infra', 'ansible', 'roles', 'docker', 'tasks', 'main.yml')).toContain(
      'subnet: "{{ kamal_network_subnet }}"',
    );
    expect(groupVars.cloudflare_ips).not.toContain('2a06:98c0::/29');
    // No rule still opens a host service to every Docker bridge.
    for (const file of [
      ['roles', 'base', 'tasks', 'main.yml'],
      ['roles', 'docker', 'templates', 'inmolink-origin-lock.j2'],
      ['roles', 'postgres', 'templates', 'pg_hba.conf.j2'],
    ]) {
      expect(read('infra', 'ansible', ...file), file.join('/')).not.toContain('172.16.0.0/12');
    }
    for (const app of APPS.filter((a) => a !== 'worker')) {
      const trusted = kamal(app).env.clear.TRUST_PROXY ?? '';
      expect(trusted, app).not.toContain('172.16.0.0/12');
      expect(trusted, app).not.toContain('2a06:98c0');
    }
  });

  it('[S1-F2] apps reach Postgres only through PgBouncer: no app_system path in pg_hba, no 5432 firewall hole', () => {
    // The direct LISTEN connection (app_system from app hosts and the kamal network) went with ADR 0014.
    const hba = read('infra', 'ansible', 'roles', 'postgres', 'templates', 'pg_hba.conf.j2');
    expect(hba.split('\n').filter((l) => /^host\s/.test(l) && l.includes('app_system'))).toEqual([]);
    expect(hba).not.toContain('kamal_network_subnet');
    const base = read('infra', 'ansible', 'roles', 'base', 'tasks', 'main.yml');
    expect(base).toContain('loop: ["{{ pgbouncer_port }}", "{{ redis_queue_port }}"]');
    expect(base).not.toContain('{{ postgres_port }}');
    for (const app of APPS) expect(kamal(app).env.secret, app).not.toContain('DATABASE_URL_LISTEN');
  });

  it('[S1-F5] redis-cache needs a password; request apps get the Meilisearch search key, never the master key', () => {
    const api = kamal('api') as Kamal & {
      accessories: Record<string, { cmd?: string; env?: { secret?: string[] } }>;
    };
    expect(api.accessories['redis-cache']?.cmd).toContain('requirepass');
    expect(api.accessories['redis-cache']?.env?.secret).toEqual(['REDIS_CACHE_PASSWORD']);
    for (const app of APPS) {
      const k = kamal(app);
      // The URL carries the password, so it is a secret everywhere.
      expect(Object.keys(k.env.clear), app).not.toContain('REDIS_CACHE_URL');
      if (k.env.clear.APP_ROLE === 'http') expect(k.env.secret, app).not.toContain('MEILI_MASTER_KEY');
    }
    for (const app of ['api', 'feed-api']) expect(kamal(app).env.secret, app).toContain('MEILI_SEARCH_KEY');
    // S5-02: the indexing pool gets a key scoped to the listings indexes under the variable name, never the master.
    const worker = kamal('worker');
    expect(worker.servers.workers?.env?.secret).toContain('MEILI_MASTER_KEY:MEILI_INDEXING_KEY');
    expect(worker.servers.workers?.env?.secret).not.toContain('MEILI_MASTER_KEY');
    expect(JSON.stringify(worker.servers.media)).not.toContain('MEILI');
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

describe('test-only network allowances (S7-F1)', () => {
  const PRELOAD = /loopback-feeds|allowLoopbackOriginsForTests/;
  const infraFiles = (dir: string): string[] =>
    readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })
      .filter((d) => d.isFile() && /\.(ya?ml|sh|json|j2|conf|env)$|Dockerfile$/.test(d.name))
      .map((d) => join(d.parentPath, d.name));

  it('[S7-F1] no production start command loads the loopback test allowance', () => {
    // the apps' start scripts (what the image runs) and their dev scripts never preload it
    for (const app of APPS) {
      const pkg = JSON.parse(read('apps', app, 'package.json')) as { scripts?: Record<string, string> };
      for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
        expect(script, `${app} ${name}`).not.toMatch(PRELOAD);
      }
    }
    // the image: NODE_ENV=production (the allowance refuses it), tests/ removed, the CMD preloads telemetry only
    const dockerfile = read('infra', 'docker', 'app', 'Dockerfile');
    expect(dockerfile).toMatch(/ENV NODE_ENV=production/);
    expect(dockerfile).toMatch(/rm -rf [^\n]*\btests\b/);
    expect(dockerfile).not.toMatch(PRELOAD);
    for (const cmd of dockerfile.split('\n').filter((l) => l.startsWith('CMD'))) {
      expect([...cmd.matchAll(/--import\s+(\S+)/g)].map((m) => m[1])).toEqual([
        '@inmolink/platform/telemetry/register',
      ]);
    }
    // deploy config (Kamal, Ansible, CI workflows): nothing names the preload or sets NODE_ENV to test
    for (const file of [...infraFiles('infra'), ...infraFiles('.github')]) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(PRELOAD);
      if (!file.includes('.github')) expect(text, file).not.toMatch(/NODE_ENV:\s*["']?test/);
    }
    // only the e2e stack (Playwright) preloads it
    expect(read('playwright.config.ts')).toMatch(/loopback-feeds/);
  });
});
