// pnpm perf:soak:sample [--test | --staging] [--interval 60] [--seconds N] [--out file.jsonl]
//                       [--containers <regex>] [--pid <name>=<pid> ...] [--no-pg] [--no-redis]
// pnpm perf:soak:sample --report file.jsonl [--warmup-minutes 30] [--load-until <ISO time | ms>]
//
// Soak (S16-01, PLAN §15 "24 h at 50 % load; no memory growth, no connection exhaustion"): runs beside the k6 soak
// profiles (`tests/load/website-api.js` and `tests/load/dashboard.js` with PROFILE=soak) and appends one sample per
// interval to a JSONL file:
//   - `mem:<container>` — resident memory of each Docker container whose name matches --containers (on the staging app
//     and worker hosts: the Kamal containers), `mem:<name>` for each --pid (a local app process);
//   - `pg:<role>` client connections per database role and `pg:total` (pg_stat_activity; read-only, any role can
//     count sessions — other roles' rows show `backend_type` null without pg_read_all_stats, hence the coalesce), with max_connections as the limit;
//   - `redis:<queue|cache|limits>:clients` and `:mem` (INFO clients / memory), with maxclients as the limit.
// On exit (SIGINT, --seconds reached) and with --report it prints the verdict of `tests/load/lib/soak.ts` and exits
// non-zero on a failure. Read-only: it never writes to a database or a Redis. Runbook: docs/runbooks/load-suite.md › Soak.
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { databaseEnv, loadConfigOrExit, rateLimitEnv, redisEnv } from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import { Redis } from 'ioredis';
import pg from 'pg';
import {
  parseDockerMem,
  parseProcStatusRss,
  parseRedisInfo,
  parseTasklistRss,
  SOAK,
  type SoakLimits,
  type SoakSample,
  soakText,
  soakVerdict,
} from '../../tests/load/lib/soak';
import { readStackEnv } from '../ops/stack-env';
import { assertLoadTarget } from './load-sites';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..');

const { values } = parseArgs({
  options: {
    test: { type: 'boolean', default: false },
    staging: { type: 'boolean', default: false },
    interval: { type: 'string', default: '60' },
    seconds: { type: 'string' },
    out: { type: 'string' },
    containers: { type: 'string' },
    pid: { type: 'string', multiple: true, default: [] },
    'no-pg': { type: 'boolean', default: false },
    'no-redis': { type: 'boolean', default: false },
    report: { type: 'string' },
    'warmup-minutes': { type: 'string', default: String(SOAK.warmupMs / 60_000) },
    'load-until': { type: 'string' },
  },
});
const log = createLogger({ service: 'perf:soak-sample', level: 'info' });

const positive = (name: string, v: string | undefined) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`--${name} must be a positive number`);
  return n;
};
const warmupMs = Number(values['warmup-minutes']) * 60_000;
if (!Number.isFinite(warmupMs) || warmupMs < 0) throw new TypeError('--warmup-minutes must be ≥ 0');
/** When the load stopped (ISO time or ms since the epoch): later samples are not judged. Default: the end of --seconds. */
let loadUntil = Number.POSITIVE_INFINITY;
if (values['load-until']) {
  const v = values['load-until'];
  loadUntil = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(loadUntil)) throw new TypeError('--load-until takes an ISO time or ms since the epoch');
}

function readSamples(file: string): { samples: SoakSample[]; limits: SoakLimits } {
  const samples: SoakSample[] = [];
  const limits: SoakLimits = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as SoakSample & { limits?: SoakLimits };
    samples.push({ t: row.t, values: row.values });
    Object.assign(limits, row.limits ?? {});
  }
  return { samples, limits };
}

function report(file: string): boolean {
  const { samples, limits } = readSamples(file);
  const verdict = soakVerdict(samples, limits, { warmupMs, loadUntil });
  process.stdout.write(soakText(verdict));
  return verdict.pass;
}

if (values.report) {
  process.exit(report(values.report) ? 0 : 1);
}

// Locally the stack's env file (dev, or --test); on staging the host's env (DATABASE_URL_*, REDIS_*_URL).
if (process.env.NODE_ENV !== 'production' && !Object.keys(process.env).some((k) => k.startsWith('DATABASE_URL_'))) {
  for (const [k, v] of Object.entries(readStackEnv(values.test ? 'test' : 'dev'))) process.env[k] ??= v;
}
assertLoadTarget(process.env, values.staging);

const intervalMs = positive('interval', values.interval) * 1_000;
const stopAt = values.seconds ? Date.now() + positive('seconds', values.seconds) * 1_000 : Number.POSITIVE_INFINITY;
// Sized to the load (`--seconds` = the k6 run's length, started together): the load ends when sampling does.
if (!values['load-until'] && Number.isFinite(stopAt)) loadUntil = stopAt;
const out =
  values.out ?? join(ROOT, 'tests', 'load', '.data', `soak-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
mkdirSync(dirname(out), { recursive: true });
const containerPattern = values.containers ? new RegExp(values.containers) : null;
const pids = values.pid.map((p) => {
  const [name, id] = p.split('=');
  if (!name || !id || !/^\d+$/.test(id)) throw new TypeError(`--pid takes <name>=<pid>, got ${p}`);
  return { name, pid: Number(id) };
});

// One session each, kept for the whole run: the sampler's own connection is one known, constant session.
const config = loadConfigOrExit({
  DATABASE_URL_APP_USER: databaseEnv.DATABASE_URL_APP_USER,
  DATABASE_URL_APP_SYSTEM: databaseEnv.DATABASE_URL_APP_SYSTEM,
  ...redisEnv,
  REDIS_LIMITS_URL: rateLimitEnv.REDIS_LIMITS_URL.optional(),
});
const pgUrl = config.DATABASE_URL_APP_SYSTEM ?? config.DATABASE_URL_APP_USER;
const pgClient =
  values['no-pg'] || !pgUrl ? null : new pg.Client({ connectionString: pgUrl, application_name: 'soak-sampler' });
const redisCandidates: [string, string | undefined][] = [
  ['queue', config.REDIS_QUEUE_URL],
  ['cache', config.REDIS_CACHE_URL],
  ['limits', config.REDIS_LIMITS_URL],
];
const redisUrls = values['no-redis']
  ? []
  : redisCandidates.filter((x): x is [string, string] => typeof x[1] === 'string' && x[1] !== '');
const redis = redisUrls.map(
  ([name, url]) =>
    [name, new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectionName: 'soak-sampler' })] as const,
);

async function sampleContainers(v: Record<string, number>) {
  if (!containerPattern) return;
  const { stdout } = await run('docker', ['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}']);
  for (const line of stdout.split('\n')) {
    const [name, usage] = line.split('\t');
    if (name && usage && containerPattern.test(name)) v[`mem:${name}`] = parseDockerMem(usage);
  }
}

async function samplePids(v: Record<string, number>) {
  for (const { name, pid } of pids) {
    try {
      if (platform() === 'win32') {
        const { stdout } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
        v[`mem:${name}`] = parseTasklistRss(stdout.trim());
      } else {
        v[`mem:${name}`] = parseProcStatusRss(readFileSync(`/proc/${pid}/status`, 'utf8'));
      }
    } catch (err) {
      log.warn({ name, pid, err: String(err) }, 'process gone or unreadable');
    }
  }
}

async function samplePg(v: Record<string, number>, limits: SoakLimits) {
  if (!pgClient) return;
  const rows = await pgClient.query<{ usename: string | null; n: string }>(
    `select usename, count(*)::int as n from pg_stat_activity where usename is not null and coalesce(backend_type, 'client backend') = 'client backend' group by usename`,
  );
  let total = 0;
  for (const r of rows.rows) {
    const n = Number(r.n);
    total += n;
    v[`pg:${r.usename ?? 'unknown'}`] = n;
  }
  v['pg:total'] = total;
  const max = await pgClient.query<{ m: string }>(`select current_setting('max_connections') as m`);
  limits['pg:total'] = Number(max.rows[0]?.m);
}

async function sampleRedis(v: Record<string, number>, limits: SoakLimits) {
  for (const [name, client] of redis) {
    const clients = parseRedisInfo(await client.info('clients'));
    const memory = parseRedisInfo(await client.info('memory'));
    v[`redis:${name}:clients`] = Number(clients.connected_clients);
    v[`redis:${name}:mem`] = Number(memory.used_memory);
    if (clients.maxclients) limits[`redis:${name}:clients`] = Number(clients.maxclients);
  }
}

let stopping = false;
async function main() {
  await pgClient?.connect();
  for (const [, c] of redis) await c.connect();
  log.info(
    { out, intervalMs, containers: values.containers ?? null, pids: pids.length, redis: redis.length },
    'sampling',
  );
  while (!stopping && Date.now() < stopAt) {
    const started = Date.now();
    const v: Record<string, number> = {};
    const limits: SoakLimits = {};
    const probes = await Promise.allSettled([
      sampleContainers(v),
      samplePids(v),
      samplePg(v, limits),
      sampleRedis(v, limits),
    ]);
    for (const p of probes) if (p.status === 'rejected') log.warn({ err: String(p.reason) }, 'probe failed');
    appendFileSync(out, `${JSON.stringify({ t: started, values: v, limits })}\n`);
    const wait = intervalMs - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, Math.max(0, stopAt - Date.now()))));
  }
}

async function finish(): Promise<never> {
  await pgClient?.end().catch(() => undefined);
  for (const [, c] of redis) c.disconnect();
  let pass = false;
  if (existsSync(out)) {
    try {
      pass = report(out);
    } catch (err) {
      log.error({ err: String(err) }, 'no verdict');
    }
  }
  log.info({ out }, 'samples written');
  process.exit(pass ? 0 : 1);
}

process.on('SIGINT', () => {
  stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});
main()
  .catch((err) => log.error({ err: String(err) }, 'sampler failed'))
  .finally(finish);
