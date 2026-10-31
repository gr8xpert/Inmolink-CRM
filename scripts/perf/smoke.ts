// pnpm perf:smoke [website-api | search-ai | selection | realtime] [--sockets 50] [--agencies 40] [--sites 8] [--rate 20] [--duration 60] [--engine] [--skip-seed] [--keep-keys]
//
// The 60-second local version of the website API load test (S7-08, .claude/rules/testing.md › Load) against the
// docker `test` stack: scale-seeds --agencies agencies (idempotent), rebuilds their read models (search documents,
// public codes, change log), provisions --sites load-test sites and keys, starts the real feed-api (its own process,
// real key check and limiter; the Postgres search fallback unless --engine), runs `tests/load/website-api.js` in the
// pinned k6 image and prints p50 / p95 / p99 per scenario and endpoint, the rate held and the error rate. Exits
// non-zero when a threshold fails. Keys are revoked afterwards (unless --keep-keys). Runbook: website-api.md › Load test.
//
// S13-F10: two more routes, driven from Node at --rate for --duration seconds after one warm-up pass (a smoke, not a
// load test): `search-ai` is the warm `GET /v2/search/ai` on feed-api (the same sentences again: p95 < 150 ms, <= 3
// statements per request, no error); `selection` is the selection page `GET /s/<token>` of apps/public (`next start`
// from its build, a 50-item selection of a scale-seed agency, a distinct client address per request: p95 < 150 ms,
// <= 5 statements per request, no error).
//
// S16-01: `realtime` starts the real apps/realtime process on the test stack, holds --sockets sockets on
// `/notifications` from `tests/load/realtime.js` (k6 smoke profile), publishes notifications at --rate a second for
// --duration seconds through redis-cache (`scripts/perf/realtime-publisher.ts`, in this process) and prints connect p95,
// fan-out p50 / p95 / p99, unexpected disconnects and the share delivered. Members: lane A's tokens file
// (`tests/load/.data/dashboard-users.json`) when it covers the run, else tokens minted here for scale-seed members.
//
// S16-01: `dashboard [--users 20]` scale-seeds --agencies agencies (unless --skip-seed), mints 15-minute access tokens
// for --users scale-seed agents (`scripts/perf/load-tokens.ts`, with its refresh service on for the run), starts the real
// apps/api (TRUST_PROXY=1: each member's office address in `X-Forwarded-For`), runs `tests/load/dashboard.js` (smoke
// profile, --users VUs for --duration seconds) in the pinned k6 image and prints p50 / p95 / p99 per endpoint and the
// statements per request of the API's roles (`app_user`, `app_auth`): fails on a k6 threshold or over 10.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { CreateSelectionBody } from '@inmolink/contracts';
import { withMemberCtx } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import * as media from '@inmolink/core/modules/media';
import * as presentations from '@inmolink/core/modules/presentations';
import * as search from '@inmolink/core/modules/search';
import { closeDb, configureDb, dbEnv, withSystem } from '@inmolink/db';
import { adminQuery } from '@inmolink/db/testing';
import { cacheConnection, closeCache, configureCache, whenReady } from '@inmolink/platform/cache';
import { authSignEnv, cryptoEnv, loadConfigOrExit, mediaEnv, rateLimitEnv } from '@inmolink/platform/config';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { closeRateLimit } from '@inmolink/platform/rate-limit';
import { sql } from 'drizzle-orm';
import * as dash from '../../tests/load/lib/dashboard-mix';
import * as rt from '../../tests/load/lib/realtime-mix';
import { PROFILES, type ProfileName, type SummaryData, summaryReport } from '../../tests/load/lib/website-mix';
import { readStackEnv } from '../ops/stack-env';
import { scaleEmail } from '../seed/identity';
import { DEFAULT_DEMO_PASSWORD, runScaleSeed } from '../seed/run';
import { assertLoadTarget, loadTestAgencies, provisionLoadSites, revokeLoadKeys } from './load-sites';
import * as tokens from './load-tokens';
import { DEFAULT_USERS_FILE, readUsersFile, runPublisher } from './realtime-publisher';

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
    sockets: { type: 'string', default: String(rt.PROFILES.smoke.sockets) },
    users: { type: 'string', default: String(dash.PROFILES.smoke.vus) },
  },
});
const SCENARIOS = ['website-api', 'search-ai', 'selection', 'realtime', 'dashboard'] as const;
const scenario = (positionals[0] ?? 'website-api') as (typeof SCENARIOS)[number];
if (!SCENARIOS.includes(scenario)) {
  throw new TypeError(`unknown scenario ${scenario} (scenarios: ${SCENARIOS.join(', ')})`);
}

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

/** Budgets of the Node-driven routes (S13-F10): p95 at origin, statements per request, errors. */
const ROUTE_BUDGETS = {
  'search-ai': { p95Ms: 150, statements: 3 },
  selection: { p95Ms: 150, statements: 5 },
} as const;

interface RouteRequest {
  url: string;
  headers: Record<string, string>;
}

const percentile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0;

/**
 * One warm-up pass over `requests`, then `duration` seconds at `rate` requests per second from `workers` parallel
 * loops (each paced to its share). Every status other than 200 is an error.
 */
async function driveRoute(
  requests: readonly RouteRequest[],
  opts: { rate: number; duration: number; workers: number },
) {
  for (const r of requests.slice(0, 50)) await fetch(r.url, { headers: r.headers }).then((res) => res.arrayBuffer());
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  const started = performance.now();
  const until = started + opts.duration * 1_000;
  const gap = (opts.workers / opts.rate) * 1_000;
  let n = 0;
  await Promise.all(
    Array.from({ length: opts.workers }, async (_, w) => {
      let next = started + (w * gap) / opts.workers;
      while (next < until) {
        const wait = next - performance.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        next += gap;
        const r = requests[n++ % requests.length] as RouteRequest;
        const t = performance.now();
        let status = 0;
        try {
          const res = await fetch(r.url, { headers: r.headers, redirect: 'manual' });
          await res.arrayBuffer();
          status = res.status;
        } catch {
          status = 0;
        }
        latencies.push(performance.now() - t);
        statuses[String(status)] = (statuses[String(status)] ?? 0) + 1;
      }
    }),
  );
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    requests: sorted.length,
    rps: Math.round((sorted.length / opts.duration) * 10) / 10,
    p50Ms: Math.round(percentile(sorted, 0.5)),
    p95Ms: Math.round(percentile(sorted, 0.95)),
    p99Ms: Math.round(percentile(sorted, 0.99)),
    maxMs: Math.round(sorted.at(-1) ?? 0),
    errors: sorted.length - (statuses['200'] ?? 0),
    statuses,
  };
}

/** apps/public from its build (`pnpm --filter @inmolink/app-public build`), on the test stack. */
async function startPublicApp(port: number, hmacKey: string): Promise<ChildProcess> {
  const dir = join(ROOT, 'apps', 'public');
  if (!existsSync(join(dir, '.next', 'BUILD_ID'))) {
    throw new Error('apps/public is not built: pnpm --filter @inmolink/app-public build');
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...stackEnv,
    APP_ROLE: 'http',
    NODE_ENV: 'production',
    LOG_LEVEL: 'warn',
    // One proxy hop: the client address is the request's X-Forwarded-For (the page limits 60 views a minute per address).
    TRUST_PROXY: '1',
    PUBLIC_URL: 'https://sites.smoke.example',
    // `next start` is always NODE_ENV=production, whose config refuses the stack's dev key, the master search key and a
    // plain-http media host: a key of this run's own (the selection is created with it), the search-only key.
    HMAC_KEY: hmacKey,
    MEDIA_CDN_URL: 'https://media.smoke.example',
    MEILI_SEARCH_KEY: stackEnv.MEILI_SEARCH_KEY ?? stackEnv.MEILI_MASTER_KEY ?? 'smoke-search-key',
    ...(values.engine ? {} : { MEILI_URL: 'http://127.0.0.1:9' }),
  };
  delete env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete env.MEILI_MASTER_KEY;
  const next = join(dir, 'node_modules', 'next', 'dist', 'bin', 'next');
  const child = spawn(process.execPath, [next, 'start', '--port', String(port)], {
    cwd: dir,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`apps/public exited (${child.exitCode})`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' })).status > 0) return child;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('apps/public did not start within 90 s');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** A selection of up to 50 listings (25 of a scale-seed agency's own, the rest other agencies') for the page. */
async function seedSelection(publicUrl: string, hmacKey: string): Promise<{ token: string; items: number }> {
  const [agency] = await loadTestAgencies(1);
  if (!agency) throw new Error('no verified scale-seed agency: seed first (omit --skip-seed)');
  presentations.configurePresentations({ tokenKey: hmacKey, publicBaseUrl: publicUrl });
  const ids = await withSystem('perf.smoke.selection', async (tx) => {
    const own = await tx.execute<{ target_id: string }>(sql`
      select distinct target_id from listing_search_docs where owner_agency_id = ${agency.agencyId} limit 25`);
    const others = await tx.execute<{ target_id: string }>(sql`
      select distinct target_id from listing_search_docs where owner_agency_id <> ${agency.agencyId} limit 40`);
    return [...own.rows.map((r) => r.target_id), ...others.rows.map((r) => r.target_id)];
  });
  const made = await withMemberCtx(
    { userId: agency.userId, agencyId: agency.agencyId, requestId: newId(), locale: 'en' },
    (ctx) =>
      presentations.createSelection(
        ctx,
        CreateSelectionBody.parse({
          title: 'Smoke selection (S13-F10)',
          locale: 'en',
          items: ids.slice(0, 50).map((targetId) => ({ targetId })),
          expiresInDays: 1,
        }),
      ),
  );
  return { token: made.share.token, items: made.selection.items.length };
}

/** apps/realtime (S16-01) on the test stack, reachable from the k6 container. */
async function startRealtimeApp(port: number): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...stackEnv,
    APP_ROLE: 'http',
    LOG_LEVEL: 'warn',
    // every interface for the length of the run (k6 runs in a container), like feed-api above
    HOST: '0.0.0.0',
    REALTIME_PORT: String(port),
    REALTIME_METRICS_PORT: '0',
  };
  delete env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--conditions=@inmolink/source', join(ROOT, 'apps', 'realtime', 'src', 'main.ts')],
    { cwd: join(ROOT, 'apps', 'realtime'), env, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`realtime exited (${child.exitCode})`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return child;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('realtime did not start within 90 s');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * The members k6 connects as: lane A's tokens file when it has enough members and its tokens outlive the run, else
 * tokens minted here for scale-seed agents through `identity.issueAccessToken` (load-tokens: membership, account status
 * and session version checked as for a signed-in member), written to its own file (mode 600).
 */
async function realtimeUsersFile(needed: number, closeAt: number): Promise<string> {
  if (existsSync(DEFAULT_USERS_FILE)) {
    const file = readUsersFile(DEFAULT_USERS_FILE);
    if (file.users.length >= needed && Date.parse(file.expiresAt) > closeAt + 30_000) return DEFAULT_USERS_FILE;
  }
  const members = await tokens.pickLoadMembers(needed);
  if (members.length < needed) {
    throw new Error(
      `${members.length} scale-seed agents in verified agencies, ${needed} needed: seed first (pnpm perf:smoke)`,
    );
  }
  const path = join(DATA_DIR, 'realtime-users.json');
  tokens.writeUsersFile(path, await tokens.mintUsersFile(members));
  return path;
}

/**
 * S16-01: the realtime smoke — real apps/realtime, k6 holding the sockets, the publisher in this process. Fails on a
 * k6 threshold or when under 99.9 % of the steady-phase deliveries arrived.
 */
async function runRealtimeSmoke(): Promise<void> {
  let app: ChildProcess | undefined;
  const abort = new AbortController();
  try {
    assertLoadTarget(process.env, false);
    const config = loadConfigOrExit({ ...dbEnv, ...authSignEnv, ...rateLimitEnv, HMAC_KEY: cryptoEnv.HMAC_KEY });
    await configureDb(config, { logger: log });
    await tokens.configureTokenMinting(config, log);
    await configureCache({ url: stackEnv.REDIS_CACHE_URL, logger: log });
    await whenReady(cacheConnection(), 10_000);
    const profile = rt.resolveProfile({
      PROFILE: 'smoke',
      SOCKETS: values.sockets,
      EVENT_RATE: String(rate),
      DURATION: String(duration),
    });
    const port = await freePort();
    app = await startRealtimeApp(port);
    // One start for k6 and the publisher, far enough ahead for the k6 container to come up.
    const startAt = Date.now() + 20_000;
    const tl = rt.timeline(profile, startAt);
    const usersPath = await realtimeUsersFile(rt.usersNeeded(profile.sockets), tl.closeAt);
    const users = readUsersFile(usersPath).users;
    const summaryFile = 'summary-realtime-smoke.json';
    rmSync(join(DATA_DIR, summaryFile), { force: true });
    const origin = new URL(stackEnv.WEB_URL ?? 'http://localhost:3000').origin;
    const published = runPublisher({ users, profile, startAt, logger: log, signal: abort.signal });
    const code = await run('docker', [
      'run',
      '--rm',
      '--add-host=host.docker.internal:host-gateway',
      '-v',
      `${join(ROOT, 'tests', 'load')}:/load`,
      '-w',
      '/load',
      ...['-e', `BASE_URL=http://host.docker.internal:${port}`],
      ...['-e', `ORIGIN=${origin}`],
      ...['-e', 'PROFILE=smoke'],
      ...['-e', `SOCKETS=${profile.sockets}`],
      ...['-e', `EVENT_RATE=${profile.eventRate}`],
      ...['-e', `DURATION=${profile.seconds}`],
      ...['-e', `START_AT=${startAt}`],
      ...['-e', `USERS_FILE=/load/.data/${usersPath.split(/[\\/]/).pop()}`],
      ...['-e', `SUMMARY_FILE=/load/.data/${summaryFile}`],
      K6_IMAGE,
      'run',
      '--quiet',
      '/load/realtime.js',
    ]);
    abort.abort();
    const sent = await published;
    if (!existsSync(join(DATA_DIR, summaryFile))) throw new Error(`k6 exited ${code} without a summary`);
    const summary = JSON.parse(readFileSync(join(DATA_DIR, summaryFile), 'utf8')) as rt.SummaryData;
    const report = rt.summaryReport(summary, profile);
    const delivered = sent.expectedSteadyDeliveries ? report.received / sent.expectedSteadyDeliveries : null;
    log.info(
      {
        sockets: profile.sockets,
        connectP95Ms: report.connect.p95,
        connectOkRate: report.connectOkRate,
        fanoutMs: report.fanout,
        unexpectedDisconnects: report.unexpectedDisconnects,
        duplicates: report.duplicates,
        negativeLatency: report.negativeLatency,
        published: sent,
        deliveredShare: delivered === null ? null : Math.round(delivered * 10_000) / 10_000,
        failedThresholds: report.failedThresholds,
      },
      'perf:smoke realtime',
    );
    // k6's own threshold judges the derived count (rt.minSteadyDeliveries); this one the publisher's exact count —
    // the same share, so the two agree.
    process.exitCode = code;
    if (delivered === null || delivered < rt.SLO.deliveredShare) {
      log.error({ delivered }, `under ${rt.SLO.deliveredShare * 100} % of the steady-phase notifications arrived`);
      process.exitCode = 1;
    }
  } catch (err) {
    log.error({ err }, 'perf:smoke realtime failed');
    process.exitCode = 1;
  } finally {
    abort.abort();
    app?.kill();
    await closeCache();
    await closeRateLimit();
    await closeDb();
  }
}

if (scenario === 'realtime') {
  await runRealtimeSmoke();
  process.exit();
}

/** Statements run so far as these roles (`pg_stat_statements`), transaction control and session settings left out. */
async function roleStatements(roles: readonly string[]): Promise<number> {
  const rows = await adminQuery<{ n: string | null }>(
    `select sum(calls)::text as n from pg_stat_statements
      where userid = any(select oid from pg_roles where rolname = any($1::text[]))
        and query !~* '^\\s*(begin|commit|rollback|set |reset|show|discard|deallocate|select set_config)'`,
    [roles],
  );
  return Number(rows[0]?.n ?? 0);
}

/** apps/api (S16-01) on the test stack, reachable from the k6 container, trusting one proxy hop (office addresses). */
async function startApiApp(port: number): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...stackEnv,
    APP_ROLE: 'http',
    LOG_LEVEL: 'warn',
    // every interface for the length of the run (k6 runs in a container), like feed-api above
    HOST: '0.0.0.0',
    API_PORT: String(port),
    API_METRICS_PORT: '0',
    // k6 stands in for the load balancer: `X-Forwarded-For` is the member's office (one per agency), so the per-IP
    // limits see offices, as in production — not every member behind the one load-generator address.
    TRUST_PROXY: '1',
  };
  delete env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--conditions=@inmolink/source', join(ROOT, 'apps', 'api', 'src', 'main.ts')],
    { cwd: join(ROOT, 'apps', 'api'), env, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`api exited (${child.exitCode})`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return child;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('api did not start within 90 s');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** The roles the dashboard API runs statements as (tenant routes; the per-request login checks). */
const API_ROLES = ['app_user', 'app_auth'] as const;
/** CLAUDE.md dashboard budget: at most 10 queries per endpoint. */
const API_STATEMENT_BUDGET = 10;

/**
 * S16-01: the dashboard smoke — real apps/api, k6 as --users scale-seed agents (smoke profile), tokens from
 * load-tokens with its refresh service up. Fails on a k6 threshold or over 10 statements per request.
 */
async function runDashboardSmoke(): Promise<void> {
  let app: ChildProcess | undefined;
  let service: tokens.TokenService | undefined;
  try {
    assertLoadTarget(process.env, false);
    const users = positive('users', values.users);
    const config = loadConfigOrExit({ ...dbEnv, ...authSignEnv, ...rateLimitEnv, HMAC_KEY: cryptoEnv.HMAC_KEY });
    await configureDb(config, { logger: log });
    await tokens.configureTokenMinting(config, log);
    if (!values['skip-seed']) {
      await runScaleSeed({
        agencies,
        seed: SEED,
        chunk: 100,
        scalePassword: process.env.SEED_SCALE_PASSWORD ?? DEFAULT_DEMO_PASSWORD,
      });
      // As in the website run: keep the seed from a test suite's stale-agency prune while the run uses it.
      await adminQuery('update agencies set updated_at = now() where agency_id = any($1::uuid[])', [
        await seededAgencyIds(agencies),
      ]);
    }
    const profile = dash.resolveProfile({ PROFILE: 'smoke', VUS: String(users), DURATION: String(duration) });
    const members = await tokens.pickLoadMembers(users);
    if (members.length < users) throw new Error(`${members.length} scale-seed agents, ${users} needed: seed more`);
    const file = await tokens.mintUsersFile(members);
    // Off loopback so the k6 container reaches it through host.docker.internal (a local target only: see above).
    service = await tokens.startTokenService({ members, initial: file, host: '0.0.0.0', dockerLocal: true, log });
    file.refresh = { url: `http://host.docker.internal:${new URL(service.url).port}`, secret: service.secret };
    tokens.writeUsersFile(join(DATA_DIR, 'dashboard-users.json'), file);
    const port = await freePort();
    app = await startApiApp(port);
    const summaryFile = 'summary-dashboard-smoke.json';
    rmSync(join(DATA_DIR, summaryFile), { force: true });
    const before = await roleStatements(API_ROLES);
    const code = await run('docker', [
      'run',
      '--rm',
      '--add-host=host.docker.internal:host-gateway',
      '-v',
      `${join(ROOT, 'tests', 'load')}:/load`,
      '-w',
      '/load',
      ...['-e', `BASE_URL=http://host.docker.internal:${port}`],
      ...['-e', 'PROFILE=smoke'],
      ...['-e', `VUS=${profile.vus}`],
      ...['-e', `DURATION=${profile.seconds}`],
      ...['-e', 'USERS_FILE=/load/.data/dashboard-users.json'],
      ...['-e', 'CLIENT_IPS=1'],
      ...['-e', `SUMMARY_FILE=/load/.data/${summaryFile}`],
      K6_IMAGE,
      'run',
      '--quiet',
      '/load/dashboard.js',
    ]);
    if (!existsSync(join(DATA_DIR, summaryFile))) throw new Error(`k6 exited ${code} without a summary`);
    const summary = JSON.parse(readFileSync(join(DATA_DIR, summaryFile), 'utf8')) as dash.SummaryData;
    const report = dash.summaryReport(summary, profile);
    // Every statement the API ran over every API request k6 sent (ramp included). Token refreshes are not API requests;
    // their mints run as app_auth — none in a 60-second run, whose tokens outlive it.
    const statements = (await roleStatements(API_ROLES)) - before;
    const all = (summary.metrics.http_reqs?.values.count as number | undefined) ?? 0;
    const apiRequests = all - report.tokenRefreshes;
    const statementsPerRequest = apiRequests ? Math.round((statements / apiRequests) * 100) / 100 : null;
    log.info(
      { ...report, rows: undefined, statements, statementsPerRequest, remints: service.remints() },
      'perf:smoke dashboard',
    );
    console.table(report.rows);
    process.exitCode = code;
    if (statementsPerRequest !== null && statementsPerRequest > API_STATEMENT_BUDGET) {
      log.error(
        { statementsPerRequest },
        `over the dashboard budget of ${API_STATEMENT_BUDGET} statements per request`,
      );
      process.exitCode = 1;
    }
  } catch (err) {
    log.error({ err }, 'perf:smoke dashboard failed');
    process.exitCode = 1;
  } finally {
    app?.kill();
    await service?.close();
    await closeRateLimit();
    await closeDb();
  }
}

if (scenario === 'dashboard') {
  await runDashboardSmoke();
  process.exit();
}

let publicApp: ChildProcess | undefined;
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
    // The seed backdates its agencies; a test suite's setup deletes agencies untouched for 6 hours (`pruneStaleTestAgencies`),
    // which would take the seed from under a run that shares the test database with other suites (S13-F10).
    await adminQuery('update agencies set updated_at = now() where agency_id = any($1::uuid[])', [ids]);
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
  // `mode` applies only when the file is created: a file from an earlier run keeps its mode without this.
  chmodSync(join(DATA_DIR, 'website-keys.json'), 0o600);

  const port = await freePort();
  feedApi = await startFeedApi(port);
  if (scenario !== 'website-api') {
    const budget = ROUTE_BUDGETS[scenario];
    const before = await appPublicStatements();
    let requests: RouteRequest[];
    if (scenario === 'search-ai') {
      const sentences = [
        '3 bedroom villa with pool near the beach',
        'cheap flat for rent in the centre',
        'new build apartment with sea views under 300000',
        'house with garden and garage',
        '2 bed apartment with terrace',
      ];
      requests = file.keys.flatMap((k) =>
        sentences.map((q) => ({
          url: `http://127.0.0.1:${port}/v2/search/ai?${new URLSearchParams({ q })}`,
          headers: { 'x-api-key': k.key },
        })),
      );
    } else {
      const publicPort = await freePort();
      const hmacKey = `smoke-${randomBytes(24).toString('hex')}`;
      publicApp = await startPublicApp(publicPort, hmacKey);
      const { token, items } = await seedSelection(`http://127.0.0.1:${publicPort}`, hmacKey);
      log.info({ items }, 'selection ready');
      // A browser that has seen the page (no view write), from a distinct client address per request.
      requests = Array.from({ length: 2_000 }, (_, i) => ({
        url: `http://127.0.0.1:${publicPort}/s/${token}`,
        headers: {
          'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36',
          cookie: 'seen=1',
          'x-forwarded-for': `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`,
        },
      }));
    }
    const result = await driveRoute(requests, { rate, duration, workers: 8 });
    const statements = (await appPublicStatements()) - before;
    const statementsPerRequest =
      Math.round((statements / (result.requests + Math.min(50, requests.length))) * 100) / 100;
    log.info({ scenario, ...result, statementsPerRequest, budget }, `perf:smoke ${scenario}`);
    if (result.p95Ms >= budget.p95Ms || result.errors > 0 || statementsPerRequest > budget.statements) {
      log.error({ scenario }, 'over the budget');
      process.exitCode = 1;
    }
  } else {
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
      // S7-F9: on the fallback (no --engine) every search must say `degraded` — the degraded-engine run, locally.
      '-e',
      `DEGRADED=${values.engine ? '0' : '1'}`,
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
    const report = summaryReport(summary, { ...PROFILES.smoke, rate, seconds: duration, degraded: !values.engine });
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
  }
} catch (err) {
  log.error({ err }, 'perf:smoke failed');
  process.exitCode = 1;
} finally {
  feedApi?.kill();
  publicApp?.kill();
  if (provisioned && !values['keep-keys']) {
    await revokeLoadKeys().catch((err) => log.warn({ err }, 'revoking load-test keys failed'));
  }
  await closeDb();
}
