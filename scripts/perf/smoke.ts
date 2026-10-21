// pnpm perf:smoke [website-api] [--agencies 40] [--sites 8] [--rate 20] [--duration 60] [--engine] [--skip-seed] [--keep-keys]
//
// The 60-second local version of the website API load test (S7-08, .claude/rules/testing.md › Load) against the
// docker `test` stack: scale-seeds --agencies agencies (idempotent), rebuilds their read models (search documents,
// public codes, change log), provisions --sites load-test sites and keys, starts the real feed-api (its own process,
// real key check and limiter; the Postgres search fallback unless --engine), runs `tests/load/website-api.js` in the
// pinned k6 image and prints p50 / p95 / p99 per scenario and endpoint, the rate held and the error rate. Exits
// non-zero when a threshold fails. Keys are revoked afterwards (unless --keep-keys). Runbook: website-api.md › Load test.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import * as identity from '@inmolink/core/modules/identity';
import * as media from '@inmolink/core/modules/media';
import * as search from '@inmolink/core/modules/search';
import { closeDb, configureDb, dbEnv, withSystem } from '@inmolink/db';
import { adminQuery } from '@inmolink/db/testing';
import { cryptoEnv, loadConfigOrExit, mediaEnv } from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import { sql } from 'drizzle-orm';
import { PROFILES, type ProfileName, type SummaryData, summaryReport } from '../../tests/load/lib/website-mix';
import { readStackEnv } from '../ops/stack-env';
import { scaleEmail } from '../seed/identity';
import { DEFAULT_DEMO_PASSWORD, runScaleSeed } from '../seed/run';
import { provisionLoadSites, revokeLoadKeys } from './load-sites';

/** k6 image (pinned; PLAN §15 load tests). The same version runs on the staging load generator (runbook). */
export const K6_IMAGE = 'grafana/k6:1.3.0';
const ROOT = join(import.meta.dirname, '..', '..');
const DATA_DIR = join(ROOT, 'tests', 'load', '.data');
const SEED = 1;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    agencies: { type: 'string', default: '40' },
    sites: { type: 'string', default: '8' },
    rate: { type: 'string', default: String(PROFILES.smoke.rate) },
    duration: { type: 'string', default: String(PROFILES.smoke.seconds) },
    engine: { type: 'boolean', default: false },
    'skip-seed': { type: 'boolean', default: false },
    'keep-keys': { type: 'boolean', default: false },
  },
});
const scenario = positionals[0] ?? 'website-api';
if (scenario !== 'website-api') throw new TypeError(`unknown scenario ${scenario} (scenarios: website-api)`);

const positive = (name: string, v: string | undefined) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new TypeError(`--${name} must be a positive integer`);
  return n;
};
const agencies = positive('agencies', values.agencies);
const sites = positive('sites', values.sites);
const rate = positive('rate', values.rate);
const duration = positive('duration', values.duration);

if (process.env.NODE_ENV === 'production') throw new Error('perf:smoke runs against the local test stack only');
// Always the test stack: its env file, never whatever DATABASE_URL_* the shell holds.
const stackEnv = readStackEnv('test');
for (const [k, v] of Object.entries(stackEnv)) if (v !== undefined) process.env[k] = v;
process.env.APP_ROLE = 'script';
// Its own progress at info whatever the stack's env file says (feed-api logs warnings only).
const log = createLogger({ service: 'perf:smoke', level: 'info' });

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

const run = (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env: opts.env ?? process.env });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });

/** The scale-seed agencies 0…n-1 (their admins' e-mails are deterministic). */
async function seededAgencyIds(n: number): Promise<string[]> {
  const emails = Array.from({ length: n }, (_, a) => scaleEmail(SEED, a, 0));
  return withSystem('perf.smoke.agencies', async (tx) => {
    const rows = await tx.execute<{ agency_id: string }>(sql`
      select distinct agency_id from agency_members where email in (${sql.join(
        emails.map((e) => sql`${e}`),
        sql`, `,
      )})`);
    return rows.rows.map((r) => r.agency_id);
  });
}

/**
 * Statements run as `app_public` so far (`pg_stat_statements`, admin connection): what feed-api sends to Postgres,
 * without transaction control and session settings.
 */
async function appPublicStatements(): Promise<number> {
  const rows = await adminQuery<{ n: string | null }>(
    `select sum(calls)::text as n from pg_stat_statements
      where userid = 'app_public'::regrole
        and query !~* '^\\s*(begin|commit|rollback|set |reset|show|discard|deallocate|select set_config)'`,
  );
  return Number(rows[0]?.n ?? 0);
}

async function startFeedApi(port: number): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...stackEnv,
    APP_ROLE: 'http',
    LOG_LEVEL: 'warn',
    // Reachable from the k6 container: Docker Desktop's host.docker.internal does not reach a loopback-only listener,
    // so feed-api listens on every interface for the length of the run (a local test stack; never a deployed app).
    HOST: '0.0.0.0',
    FEED_API_PORT: String(port),
    FEED_API_METRICS_PORT: '0',
    // The Postgres fallback (S5-04: website search's slowest backend) unless --engine: the local index does not hold
    // the freshly rebuilt documents (the search worker is not running).
    ...(values.engine ? {} : { MEILI_URL: 'http://127.0.0.1:9' }),
  };
  // No trace export from a load run.
  delete env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--conditions=@inmolink/source', join(ROOT, 'apps', 'feed-api', 'src', 'main.ts')],
    { cwd: join(ROOT, 'apps', 'feed-api'), env, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`feed-api exited (${child.exitCode})`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return child;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('feed-api did not start within 90 s');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

let feedApi: ChildProcess | undefined;
let provisioned = false;
try {
  const config = loadConfigOrExit({ ...dbEnv, ...mediaEnv, HMAC_KEY: cryptoEnv.HMAC_KEY });
  await configureDb(config, { logger: log });
  media.configureMedia({ urlKey: config.MEDIA_URL_KEY });
  identity.configureIdentity({
    hmacKey: config.HMAC_KEY,
    apiKeyEnv: identity.apiKeyEnvFor(process.env.DEPLOY_ENV ?? process.env.NODE_ENV),
  });

  if (!values['skip-seed']) {
    const started = Date.now();
    await runScaleSeed({
      agencies,
      seed: SEED,
      chunk: 100,
      scalePassword: process.env.SEED_SCALE_PASSWORD ?? DEFAULT_DEMO_PASSWORD,
    });
    const ids = await seededAgencyIds(agencies);
    let built = 0;
    for (const agencyId of ids) {
      const r = await search.rebuildAllReadModels({ agencyId, reason: 'perf.smoke.read-models' });
      built += r.LISTING.built + r.UNIT.built;
    }
    log.info({ agencies: ids.length, built, seconds: Math.round((Date.now() - started) / 1000) }, 'scale seed ready');
  }

  const file = await provisionLoadSites({ sites });
  provisioned = true;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, 'website-keys.json'), JSON.stringify(file), { mode: 0o600 });

  const port = await freePort();
  feedApi = await startFeedApi(port);
  const profile: ProfileName = 'smoke';
  const summaryFile = 'summary-smoke.json';
  rmSync(join(DATA_DIR, summaryFile), { force: true });
  const before = await appPublicStatements();
  const code = await run('docker', [
    'run',
    '--rm',
    '--add-host=host.docker.internal:host-gateway',
    '-v',
    `${join(ROOT, 'tests', 'load')}:/load`,
    '-w',
    '/load',
    '-e',
    `BASE_URL=http://host.docker.internal:${port}`,
    '-e',
    `PROFILE=${profile}`,
    '-e',
    `RATE=${rate}`,
    '-e',
    `DURATION=${duration}`,
    '-e',
    'KEYS_FILE=/load/.data/website-keys.json',
    '-e',
    `SUMMARY_FILE=/load/.data/${summaryFile}`,
    K6_IMAGE,
    'run',
    '--quiet',
    '/load/website-api.js',
  ]);
  if (!existsSync(join(DATA_DIR, summaryFile))) throw new Error(`k6 exited ${code} without a summary`);
  const summary = JSON.parse(readFileSync(join(DATA_DIR, summaryFile), 'utf8')) as SummaryData;
  const report = summaryReport(summary, { ...PROFILES.smoke, rate, seconds: duration });
  // Query budget (feed-api ≤ 3 statements per request): every statement feed-api ran (role app_public, transaction
  // control and settings left out) over every request k6 sent, setup and warm-up included.
  const statements = (await appPublicStatements()) - before;
  const requests = (summary.metrics.http_reqs?.values.count as number | undefined) ?? 0;
  const statementsPerRequest = requests ? Math.round((statements / requests) * 100) / 100 : null;
  log.info({ ...report, rows: undefined, statements, statementsPerRequest }, 'perf:smoke website-api');
  if (statementsPerRequest !== null && statementsPerRequest > 3) {
    log.error({ statementsPerRequest }, 'over the feed-api budget of 3 statements per request');
    if (code === 0) process.exitCode = 1;
  }
  console.table(report.rows);
  if (!process.exitCode) process.exitCode = code;
} catch (err) {
  log.error({ err }, 'perf:smoke failed');
  process.exitCode = 1;
} finally {
  feedApi?.kill();
  if (provisioned && !values['keep-keys']) {
    await revokeLoadKeys().catch((err) => log.warn({ err }, 'revoking load-test keys failed'));
  }
  await closeDb();
}
