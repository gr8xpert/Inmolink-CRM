// pnpm perf:storm import   [--test | --staging] [--profile smoke|staging] [--feeds N] [--max-queue-age-ms N]
//                          [--timeout-ms N] [--feed-base-url URL --listen HOST:PORT] [--workers local|external]
//                          [--keep] [--out file.json]
// pnpm perf:storm matching [--test | --staging] [--profile smoke|staging] [--changes N] [--window-ms N]
//                          [--max-process-ms N] [--profiles N] [--agencies N] [--timeout-ms N]
//                          [--workers local|external] [--keep] [--out file.json]
// pnpm perf:storm cleanup  [--test | --staging] [--listings]
//   (removes what an interrupted run left: storm connections and profiles, and restores the prices a matching storm
//   dropped; --listings also deletes the imported `STORM-*` listings through `properties.deleteListing`)
//
// Queue/worker storms of S16-01 (PLAN §15). Not k6: neither storm has an HTTP surface whose latency is the target —
// k6 can neither serve the feeds the workers fetch nor read queue ages or match states — so these drive the real
// stack from Node and report in the k6 runs' summary style, thresholds as code (`lib/storm.ts`). Exit code 1 = FAIL.
//
// import: N synthetic Kyero v3 feeds (the format every deployed worker reads) served by a fixture HTTP server in this
//   process; one connection per feed on scale-seed agencies (`lib/storm.ts › feedMix`: some agencies hold 8 or 2
//   feeds) — S16-F4: a tenant's first feed on its seeded connection (`scripts/seed/imports.ts`, off until the storm
//   points it at its feed and turns it on, back off with its seeded URL after), only the multi-feed tenants' extra
//   feeds on storm connections created for the run; all made due in one UPDATE and picked up by the real scheduler
//   (`imports.scheduleFeeds`, one tick queued at once) → `imports.run.requested` → dispatcher → `imports.runFeed` on
//   the `imports` pool with its fair-share caps.
//   `feed_runs` is sampled every few seconds: a tenant's queue age is the longest any of its runs waited between being
//   queued (`created_at`, as the ImportQueueWaitHigh alert counts) and starting (`started_at`, or now while waiting).
//   Each connection is judged by its first run (a second one the scheduler queues later is counted, not judged).
//   Afterwards the storm connections are deleted (their runs cascade; a seeded connection keeps its runs); the
//   imported `STORM-*` listings stay, a re-run updates them, and `storm cleanup --listings` deletes them (soft delete,
//   as a member would; purged after 30 days).
// matching: `changes` listing price drops (1 %) spread evenly over `window-ms`, through `properties.updateListing` as
//   an agency admin of scale-seed agencies (so the outbox → read-model rebuild → `search.listings.changed` →
//   `matching.matchListings` path runs as in production), against at least `profiles` active saved searches (the
//   client profiles: S16-F4 the scale seed's, 200 DAILY per agency; only a shortfall is provisioned for the run, DAILY
//   too — no instant alert or notification fires for them — and deleted after it). A change is processed when
//   matching wrote the listing's state at its new version (`matching_listing_states`); the run is processed when
//   every change is, measured from the first change. The original prices are journalled (`tests/load/.data/storm-prices-<run>.json`) before the first change and restored
//   through `properties.updateListing` at the end — or by `storm cleanup` after an interrupted run; a listing whose
//   price changed again since is left alone.
//
// Workers: `--workers local` (default off staging) starts the real worker (`apps/worker/src/main.ts`, from source)
// for the pools the storm needs, on the target stack, with the e2e loopback allowance (`tests/e2e/loopback-feeds.ts`)
// for the fixture feed origin only. On staging (`--staging`, workers external) the deployed workers do the work, so the
// feed server must be reachable from them through `safeFetch` (public address, no private ranges): run it on a host
// with a public address behind port 80/443 (safeFetch's only ports; e.g. `--listen 0.0.0.0:8080` behind a TLS
// proxy) and pass that public address as `--feed-base-url` (checked with `checkUrl` before anything is created).
// Never in production (`assertLoadTarget`). Runbook: docs/runbooks/load-suite.md › Import and matching storms.
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { UpdateListingBody } from '@inmolink/contracts';
import { withMemberCtx } from '@inmolink/core';
import * as imports from '@inmolink/core/modules/imports';
import * as matching from '@inmolink/core/modules/matching';
import * as media from '@inmolink/core/modules/media';
import * as properties from '@inmolink/core/modules/properties';
import { closeDb, configureDb, dbEnv, withSystem } from '@inmolink/db';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { loadConfigOrExit } from '@inmolink/platform/config';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { closeQueues, configureQueue } from '@inmolink/platform/queue';
import { checkUrl } from '@inmolink/platform/safe-fetch';
import { type SQL, sql } from 'drizzle-orm';
import { readStackEnv } from '../ops/stack-env';
import { SEEDED_FEED_NAME } from '../seed/imports';
import * as storm from './lib/storm';
import { assertLoadTarget, loadTestAgencies } from './load-sites';

const ROOT = join(import.meta.dirname, '..', '..');
/** Where a matching storm journals the prices it drops (git-ignored, as the load tests' other run files). */
const DATA_DIR = join(ROOT, 'tests', 'load', '.data');
const PRICE_JOURNAL = /^storm-prices-[a-z0-9]+\.json$/;
/** Where an import storm journals the seeded connections' URLs it repoints (S16-F4). */
const FEED_JOURNAL = /^storm-feeds-[a-z0-9]+\.json$/;
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
/** Names of what a storm creates (cleanup finds leftovers by them). */
const CONNECTION_NAME = 'Storm (S16-01)';
const PROFILE_NAME = 'Storm (S16-01)';
const REASON = 'perf.storm';
/** Rows per provisioning statement (the database rules' batch bound). */
const PROVISION_BATCH = 5_000;
/**
 * The provisioned client profiles' alert frequency: DAILY, so matching records their matches for the digest and no
 * INSTANT alert, notification or email fires for synthetic users during the storm (or when its prices are restored).
 */
const PROVISIONED_FREQUENCY = 'DAILY' as const;
/** Listing services in flight at once when restoring prices or deleting `STORM-*` listings. */
const CLEANUP_CONCURRENCY = 8;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    test: { type: 'boolean', default: false },
    staging: { type: 'boolean', default: false },
    profile: { type: 'string' },
    feeds: { type: 'string' },
    'max-queue-age-ms': { type: 'string' },
    'timeout-ms': { type: 'string' },
    changes: { type: 'string' },
    'window-ms': { type: 'string' },
    'max-process-ms': { type: 'string' },
    profiles: { type: 'string' },
    agencies: { type: 'string' },
    'feed-base-url': { type: 'string' },
    listen: { type: 'string' },
    workers: { type: 'string' },
    listings: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});

const scenario = positionals[0];
// Locally, read the stack's env file (dev or --test) unless real credentials are already set (as load-setup does).
const stackEnv: Record<string, string> = {};
if (process.env.NODE_ENV !== 'production' && !Object.keys(process.env).some((k) => k.startsWith('DATABASE_URL_'))) {
  for (const [k, v] of Object.entries(readStackEnv(values.test ? 'test' : 'dev'))) {
    if (v === undefined) continue;
    stackEnv[k] = v;
    process.env[k] ??= v;
  }
}
process.env.APP_ROLE = 'script';
const log = createLogger({ service: 'perf:storm', level: process.env.LOG_LEVEL ?? 'info' });

const int = (name: string, v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new TypeError(`--${name} must be a positive integer`);
  return n;
};
const system = <T>(what: string, q: SQL) =>
  withSystem(`${REASON}.${what}`, async (tx) => (await tx.execute(q)).rows as T[]);
/** A uuid[] parameter (ids this driver read or generated). */
const uuids = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dbNowMs = async () =>
  Number((await system<{ t: number }>('now', sql`select extract(epoch from now()) * 1000 as t`))[0]?.t);

/* ------------------------------------------------------------------ local workers */

/** The real worker from source for `pools`, on this stack; the loopback allowance for the fixture feed port only. */
async function startLocalWorker(pools: string[], feedPort?: number): Promise<ChildProcess> {
  const health = await freePort();
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...stackEnv,
    NODE_ENV: 'test',
    LOG_LEVEL: 'warn',
    WORKER_POOLS: pools.join(','),
    WORKER_HEALTH_PORT: String(health),
    WORKER_METRICS_PORT: '0',
    ...(feedPort ? { E2E_FEED_PORT: String(feedPort) } : {}),
  };
  delete env.APP_ROLE;
  const child = spawn(
    process.execPath,
    [
      TSX,
      '--conditions=@inmolink/source',
      '--import',
      '@inmolink/platform/telemetry/register',
      '--import',
      './tests/e2e/loopback-feeds.ts',
      join('apps', 'worker', 'src', 'main.ts'),
    ],
    { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  const until = Date.now() + 180_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the local worker exited (${child.exitCode}) before it was ready`);
    const ok = await fetch(`http://127.0.0.1:${health}/readyz`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
    if (Date.now() > until) {
      child.kill();
      throw new Error('the local worker was not ready within 180 s');
    }
    await sleep(1_000);
  }
  log.info({ pools, pid: child.pid }, 'local worker ready');
  return child;
}

async function stopWorker(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = once(child, 'exit');
  // graceful shutdown finishes in-flight jobs within 30 s
  const timer = setTimeout(() => child.kill('SIGKILL'), 35_000);
  await exited;
  clearTimeout(timer);
}

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const { port } = s.address() as AddressInfo;
  s.close();
  return port;
}

/* ------------------------------------------------------------------ import storm */

async function importStorm(staging: boolean): Promise<boolean> {
  const p = storm.resolveImportProfile(values.profile ?? (staging ? 'staging' : 'smoke'), {
    feeds: int('feeds', values.feeds),
    maxQueueAgeMs: int('max-queue-age-ms', values['max-queue-age-ms']),
    timeoutMs: int('timeout-ms', values['timeout-ms']),
  });
  const localWorkers = (values.workers ?? (staging ? 'external' : 'local')) === 'local';
  if (staging && localWorkers) throw new Error('on staging the deployed workers run the storm: no --workers local');
  if (!staging && !localWorkers && !values['feed-base-url']) {
    throw new Error('external workers cannot fetch a loopback feed: pass a public --feed-base-url, or --workers local');
  }
  if (staging && (!values['feed-base-url'] || !values.listen)) {
    throw new Error('--staging needs --feed-base-url (public, reachable by the workers) and --listen HOST:PORT');
  }
  const mix = storm.feedMix(p.feeds, p.sizes);
  const needed = storm.agenciesIn(mix);
  const agencies = await loadTestAgencies(needed);
  if (agencies.length < needed) {
    throw new Error(`${agencies.length} verified scale-seed agencies with an admin; ${needed} needed (seed more)`);
  }

  const run = newId().slice(-8).toLowerCase();
  const tag = `${run}-${Date.now().toString(36)}`;
  let requests = 0;
  const server: Server = createServer((req, res) => {
    const m = /^\/storm\/([a-z0-9]+)\/(\d+)\.xml$/.exec(req.url ?? '');
    const feed = m && m[1] === run ? mix[Number(m[2])] : undefined;
    if (!feed) {
      res.writeHead(404).end();
      return;
    }
    requests++;
    const body = storm.kyeroFeedXml(feed.feed, feed.listings, tag);
    res.writeHead(200, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(body) }).end(body);
  });
  const [host, port] = (values.listen ?? '127.0.0.1:0').split(':');
  server.listen(Number(port ?? 0), host);
  await once(server, 'listening');
  const bound = (server.address() as AddressInfo).port;
  const base = (values['feed-base-url'] ?? `http://127.0.0.1:${bound}`).replace(/\/$/, '');
  // what the workers' safeFetch will say, before 500 runs fail on it (loopback is allowed only in the local worker)
  if (values['feed-base-url']) checkUrl(`${base}/storm/${run}/0.xml`);

  // S16-F4: every feed runs on a seeded connection (off; the scale seed gives the acceptance storm's multi-feed tenants
  // 8 or 2 of them: `scripts/seed/imports.ts`) — a connection is provisioned only for what the seed lacks.
  const { connections: plan } = storm.planConnections(
    mix,
    await seededConnections(),
    agencies.map((a) => a.agencyId),
    newId,
  );
  const connectionIds = plan.map((c) => c.id);
  const reused = plan.filter((c) => c.seededUrl !== null);
  const provisioned = plan.filter((c) => c.seededUrl === null);
  const feedUrl = (c: storm.StormConnection) => `${base}/storm/${run}/${(mix[c.feed] as storm.StormFeed).feed}.xml`;
  let worker: ChildProcess | undefined;
  let feedJournal: string | undefined;
  try {
    if (provisioned.length > 0) {
      await withSystem(`${REASON}.connections`, (tx) =>
        tx.execute(sql`
          insert into feed_connections (id, agency_id, name, connector, url)
          select id, agency_id, name, connector, url from jsonb_to_recordset(${JSON.stringify(
            provisioned.map((c) => ({
              id: c.id,
              agency_id: c.agencyId,
              name: `${CONNECTION_NAME} ${run} #${(mix[c.feed] as storm.StormFeed).feed}`,
              connector: 'kyero',
              url: feedUrl(c),
            })),
          )}::jsonb) as x(id uuid, agency_id uuid, name text, connector text, url text)`),
      );
    }
    if (provisioned.length > 0) {
      log.warn({ provisioned: provisioned.length }, 'the seed lacks feed connections for this mix: provisioned them');
    }
    // Their seeded URLs, journalled first: `storm cleanup` puts them back after an interrupted run.
    if (reused.length > 0) {
      feedJournal = join(DATA_DIR, `storm-feeds-${run}.json`);
      writePrivate(feedJournal, { entries: reused.map((c) => ({ id: c.id, url: c.seededUrl })) });
    }
    // The seeded ones point at this run's feeds and are turned on — a guard pause an earlier run left lifted and the
    // next run's anomaly check waived once (a reused connection's feed may differ from its last one); `finally` turns
    // them off and puts their seeded URL back.
    if (reused.length > 0) {
      await withSystem(`${REASON}.connections`, (tx) =>
        tx.execute(sql`
          update feed_connections c
             set url = x.url, enabled = true, paused_at = null, pause_reason = null, pause_details = null,
                 paused_run_id = null, accept_anomaly_once = true, version = version + 1, updated_at = now()
            from jsonb_to_recordset(${JSON.stringify(reused.map((c) => ({ id: c.id, url: feedUrl(c) })))}::jsonb)
              as x(id uuid, url text)
           where c.id = x.id`),
      );
    }
    log.info(
      { feeds: mix.length, tenants: needed, seeded: reused.length, provisioned: provisioned.length, base },
      'storm connections ready',
    );
    if (localWorkers) worker = await startLocalWorker(['outbox', 'imports', 'indexing'], bound);

    // All due at once; the scheduler's next tick queues them (one tick is queued now, the repeatable one follows).
    const [trigger] = await system<{ t: number }>(
      'trigger',
      sql`with u as (update feed_connections set next_run_at = now() where id = any(${uuids(connectionIds)}) returning 1)
          select extract(epoch from now()) * 1000 as t, (select count(*) from u)::int as n`,
    );
    const triggeredAtMs = Number(trigger?.t);
    if (process.env.REDIS_QUEUE_URL) await imports.importsJobs.scheduleFeeds.enqueue({});
    log.info({ feeds: mix.length }, 'storm triggered');

    const tracker = new storm.QueueAgeTracker();
    let extraRuns = 0;
    let timedOut = false;
    let endedAtMs = triggeredAtMs;
    for (;;) {
      await sleep(p.sampleMs);
      // One row per connection — its first run since the trigger (the one the storm triggered: a seeded connection
      // keeps earlier storms' runs), with how many it has: a second run the scheduler queues after the first ended must
      // neither stand in for a connection still waiting nor end the loop.
      const rows = await system<{
        id: string;
        agency_id: string;
        state: string;
        created: number;
        started: number | null;
        finished: number | null;
        now: number;
        runs: number;
      }>(
        'sample',
        sql`select distinct on (connection_id) id, agency_id, state::text as state,
                   extract(epoch from created_at) * 1000 as created, extract(epoch from started_at) * 1000 as started,
                   extract(epoch from finished_at) * 1000 as finished, extract(epoch from now()) * 1000 as now,
                   (count(*) over (partition by connection_id))::int as runs
              from feed_runs where connection_id = any(${uuids(connectionIds)})
               and created_at >= to_timestamp(${triggeredAtMs / 1000})
             order by connection_id, created_at, id`,
      );
      extraRuns = rows.reduce((n, r) => n + Math.max(0, Number(r.runs) - 1), 0);
      endedAtMs = rows[0] ? Number(rows[0].now) : await dbNowMs();
      const samples = rows.map((r) => ({
        runId: r.id,
        agencyId: r.agency_id,
        state: r.state,
        createdAtMs: Number(r.created),
        startedAtMs: r.started === null ? null : Number(r.started),
        finishedAtMs: r.finished === null ? null : Number(r.finished),
      }));
      tracker.observe(endedAtMs, samples);
      const ended = samples.filter((s) => storm.TERMINAL_RUN_STATES.has(s.state)).length;
      const waiting = samples.filter((s) => s.startedAtMs === null).length;
      log.info(
        {
          connections: samples.length,
          waiting,
          ended,
          extraRuns,
          oldestWaitingS: Math.round((tracker.curve.at(-1)?.[1] ?? 0) / 1000),
        },
        'storm sample',
      );
      // every connection's first run ended (samples are one per connection, so this cannot overshoot; >= all the same)
      if (ended >= connectionIds.length) break;
      if (endedAtMs - triggeredAtMs > p.timeoutMs) {
        timedOut = true;
        break;
      }
    }
    const report = storm.importReport(p, mix, tracker, {
      triggeredAtMs,
      endedAtMs,
      connections: connectionIds.length,
      timedOut,
      feedRequests: requests,
    });
    process.stdout.write(storm.importSummaryText(report));
    if (extraRuns > 0) process.stdout.write(`  later runs queued by the scheduler (not judged) ${extraRuns}\n`);
    writeOut({ ...report, extraRuns, curve: tracker.curve.map(([t, age]) => [t - triggeredAtMs, age]) });
    return report.pass;
  } finally {
    await stopWorker(worker);
    server.close();
    // the seeded connections back as the seed left them (off, their seeded URL), with --keep too; their runs stay
    if (reused.length > 0) {
      await restoreSeededConnections(reused.map((c) => ({ id: c.id, url: c.seededUrl as string })));
      if (feedJournal) rmSync(feedJournal, { force: true });
      log.info({ seeded: reused.length }, 'seeded connections turned off again');
    }
    if (!values.keep && provisioned.length > 0) {
      await withSystem(`${REASON}.cleanup`, (tx) =>
        tx.execute(sql`delete from feed_connections where id = any(${uuids(provisioned.map((c) => c.id))})`),
      );
      log.info('storm connections deleted (their runs cascade); STORM-* listings stay (storm cleanup --listings)');
    }
  }
}

/**
 * The seeded feed connections (S16-F4, `scripts/seed/imports.ts`) of every verified agency — never one with a queued
 * or running run (an interrupted storm's): the scheduler could not start another on it. ~5,100 rows at 5,000 agencies.
 */
async function seededConnections(): Promise<storm.SeededConnection[]> {
  const rows = await system<{ id: string; agency_id: string; url: string }>(
    'seeded',
    sql`select c.id, c.agency_id, c.url
          from feed_connections c join agencies a on a.agency_id = c.agency_id and a.status = 'VERIFIED'
         where c.name = ${SEEDED_FEED_NAME}
           and not exists (select 1 from feed_runs r where r.connection_id = c.id and r.state in ('QUEUED', 'RUNNING'))
         order by c.agency_id, c.id`,
  );
  return rows.map((r) => ({ id: r.id, agencyId: r.agency_id, url: r.url }));
}

/** Seeded connections back as the seed left them: off, at their seeded URL. One statement. */
async function restoreSeededConnections(entries: readonly { id: string; url: string }[]): Promise<number> {
  const rows = await system<{ id: string }>(
    'restore-feeds',
    sql`update feed_connections c
           set url = x.url, enabled = false, next_run_at = null, accept_anomaly_once = false, version = version + 1,
               updated_at = now()
          from jsonb_to_recordset(${JSON.stringify(entries)}::jsonb) as x(id uuid, url text)
         where c.id = x.id and c.name = ${SEEDED_FEED_NAME}
        returning c.id`,
  );
  return rows.length;
}

/* ------------------------------------------------------------------ matching storm */

interface StormListing {
  id: string;
  agencyId: string;
  priceCents: number;
  version: number;
}

async function matchingStorm(staging: boolean): Promise<boolean> {
  const p = storm.resolveMatchingProfile(values.profile ?? (staging ? 'staging' : 'smoke'), {
    changes: int('changes', values.changes),
    windowMs: int('window-ms', values['window-ms']),
    maxProcessMs: int('max-process-ms', values['max-process-ms']),
    profiles: int('profiles', values.profiles),
    agencies: int('agencies', values.agencies),
    timeoutMs: int('timeout-ms', values['timeout-ms']),
  });
  const localWorkers = (values.workers ?? (staging ? 'external' : 'local')) === 'local';
  if (staging && localWorkers) throw new Error('on staging the deployed workers run the storm: no --workers local');
  const run = newId().slice(-8).toLowerCase();
  const profileName = `${PROFILE_NAME} ${run}`;
  let provisioned = 0;
  let worker: ChildProcess | undefined;
  let journal = new Map<string, PriceJournalEntry>();
  let journalPath: string | undefined;
  try {
    const agencies = await loadTestAgencies(p.agencies);
    if (agencies.length < p.agencies) {
      throw new Error(`${agencies.length} verified scale-seed agencies with an admin; ${p.agencies} needed`);
    }
    const admins = new Map(agencies.map((a) => [a.agencyId, a]));

    // client profiles: what the database holds — the scale seed's (S16-F4: 200 per agency) — and only a shortfall
    // provisioned for this run (a seed of too few agencies)
    const existing = await activeProfiles();
    if (existing < p.profiles) {
      log.warn(
        { existing, needed: p.profiles },
        'fewer client profiles than the run needs: provisioning the shortfall (seed more agencies to avoid it)',
      );
      provisioned = await provisionProfiles(p.profiles - existing, profileName);
    }
    const profiles = existing + provisioned;
    log.info({ existing, provisioned, profiles }, 'client profiles ready');

    const listings = await stormListings(
      agencies.map((a) => a.agencyId),
      p.changes,
    );
    if (listings.length < p.changes) {
      throw new Error(`${listings.length} active priced listings with a search document; ${p.changes} needed`);
    }
    if (localWorkers) worker = await startLocalWorker(['outbox', 'indexing', 'matching']);

    // The prices about to drop, journalled before the first change: restored at the end, or by `storm cleanup`.
    journal = new Map(
      listings.map((l) => {
        const admin = admins.get(l.agencyId) as (typeof agencies)[number];
        return [
          l.id,
          {
            id: l.id,
            agencyId: l.agencyId,
            userId: admin.userId,
            originalCents: l.priceCents,
            droppedCents: storm.droppedPrice(l.priceCents),
          },
        ];
      }),
    );
    journalPath = join(DATA_DIR, `storm-prices-${run}.json`);
    writeJournal(journalPath, [...journal.values()]);

    const applied = new Map<string, { version: number; changedAtMs: number }>();
    const matchedAt = new Map<string, number>();
    let applyErrors = 0;
    let applying = true;
    const started = performance.now();
    let next = 0;
    const applyOne = async (l: StormListing) => {
      const admin = admins.get(l.agencyId) as (typeof agencies)[number];
      const member = { userId: admin.userId, agencyId: admin.agencyId, requestId: newId(), locale: 'en' };
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const dto = await withMemberCtx(member, async (ctx) => {
            // a conflict (someone else changed it): the second attempt reads the listing again
            const current =
              attempt === 0
                ? l
                : await properties.getListing(ctx, l.id).then((d) => ({
                    version: d.version,
                    priceCents: d.price?.amountCents ?? l.priceCents,
                  }));
            // the price this change drops from (a retry reads it again): what the restore puts back
            const entry = journal.get(l.id);
            if (entry && entry.originalCents !== current.priceCents) {
              entry.originalCents = current.priceCents;
              entry.droppedCents = storm.droppedPrice(current.priceCents);
            }
            return properties.updateListing(
              ctx,
              l.id,
              UpdateListingBody.parse({ version: current.version, priceCents: storm.droppedPrice(current.priceCents) }),
            );
          });
          applied.set(l.id, { version: dto.version, changedAtMs: Date.parse(dto.updatedAt) });
          return;
        } catch (err) {
          if ((err as { code?: string }).code === 'VERSION_CONFLICT' && attempt === 0) continue;
          applyErrors++;
          log.warn({ err, listingId: l.id }, 'storm change failed');
          return;
        }
      }
    };
    const lane = async () => {
      for (;;) {
        const i = next++;
        const l = listings[i];
        if (!l) return;
        const wait = started + storm.changeDueMs(i, listings.length, p.windowMs) - performance.now();
        if (wait > 0) await sleep(wait);
        await applyOne(l);
      }
    };
    const sampleMatched = async () => {
      const pending = [...applied].filter(([id]) => !matchedAt.has(id));
      if (pending.length === 0) return;
      const rows = await system<{ id: string; t: number }>(
        'matched',
        sql`select s.listing_id as id, extract(epoch from s.updated_at) * 1000 as t
              from unnest(${uuids(pending.map(([id]) => id))}, ${`{${pending.map(([, a]) => a.version).join(',')}}`}::int[])
                     as x(id, v)
              join matching_listing_states s on s.listing_id = x.id and s.version >= x.v`,
      );
      for (const r of rows) matchedAt.set(r.id, Number(r.t));
    };
    const sampler = (async () => {
      while (applying) {
        await sleep(p.sampleMs);
        await sampleMatched();
        log.info({ applied: applied.size, matched: matchedAt.size, errors: applyErrors }, 'storm sample');
      }
    })();
    await Promise.all(Array.from({ length: p.concurrency }, lane));
    applying = false;
    await sampler;
    log.info({ applied: applied.size, errors: applyErrors }, 'storm changes applied');
    // The journal now says exactly what changed and from which price (a retry may have read a newer one).
    journal = new Map([...journal].filter(([id]) => applied.has(id)));
    writeJournal(journalPath, [...journal.values()]);

    if (applied.size === 0) throw new Error(`no change applied (${applyErrors} failed)`);
    const firstChange = Math.min(...[...applied.values()].map((a) => a.changedAtMs));
    let timedOut = false;
    let endedAtMs = await dbNowMs();
    while (matchedAt.size < applied.size) {
      if (endedAtMs - firstChange > p.timeoutMs) {
        timedOut = true;
        break;
      }
      await sleep(p.sampleMs);
      await sampleMatched();
      endedAtMs = await dbNowMs();
      log.info({ applied: applied.size, matched: matchedAt.size }, 'storm sample');
    }
    const [alerts] = await system<{ n: number }>(
      'alerts',
      sql`select count(*)::int as n from saved_search_alerts
           where listing_id = any(${uuids([...applied.keys()])}) and created_at >= to_timestamp(${firstChange / 1000})`,
    );
    const report = storm.matchingReport(
      p,
      [...applied].map(([id, a]) => ({
        listingId: id,
        changedAtMs: a.changedAtMs,
        matchedAtMs: matchedAt.get(id) ?? null,
      })),
      {
        planned: p.changes,
        profiles,
        provisioned,
        agencies: new Set(listings.map((l) => l.agencyId)).size,
        applyErrors,
        timedOut,
        endedAtMs,
        alerts: Number(alerts?.n ?? 0),
      },
    );
    process.stdout.write(storm.matchingSummaryText(report));
    writeOut(report);
    return report.pass;
  } finally {
    // Prices back while the local worker still runs (the read models and search catch up with the restore).
    if (journalPath && journal.size > 0) {
      const restored = await restorePrices([...journal.values()]).catch((err: unknown) => {
        log.error({ err, journal: journalPath }, 'price restore failed: run storm cleanup');
        return null;
      });
      if (restored) {
        log.info(restored, 'storm prices restored');
        if (restored.failed === 0) rmSync(journalPath, { force: true });
        else log.warn({ journal: journalPath }, 'some prices not restored: storm cleanup retries them');
      }
    }
    await stopWorker(worker);
    if (provisioned > 0 && !values.keep) log.info({ deleted: await deleteProfiles(profileName) }, 'profiles deleted');
  }
}

/** One listing whose price a matching storm drops: the admin who changes it, the price before and after. */
interface PriceJournalEntry {
  id: string;
  agencyId: string;
  userId: string;
  originalCents: number;
  droppedCents: number;
}

/** A journal (feed URLs, prices) readable by its owner only, like `writeUsersFile` (S16 review). */
function writePrivate(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  // `mode` applies only when the file is created: one left by an earlier run keeps its mode without this.
  chmodSync(path, 0o600);
}

function writeJournal(path: string, entries: readonly PriceJournalEntry[]): void {
  writePrivate(path, { entries });
}

/** `fn` over `xs`, `limit` at a time. */
async function eachLimit<T>(xs: readonly T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, xs.length) }, async () => {
      for (let i = next++; i < xs.length; i = next++) await fn(xs[i] as T);
    }),
  );
}

/**
 * Puts the journalled prices back through `properties.updateListing` as the agency's admin (outbox, read models and
 * search follow as for any edit). Only a listing still at the storm's dropped price is restored: one changed since
 * (by anyone) or never changed is left alone. A version conflict is retried once.
 */
async function restorePrices(
  entries: readonly PriceJournalEntry[],
): Promise<{ restored: number; untouched: number; failed: number }> {
  const out = { restored: 0, untouched: 0, failed: 0 };
  await eachLimit(entries, CLEANUP_CONCURRENCY, async (e) => {
    const member = { userId: e.userId, agencyId: e.agencyId, requestId: newId(), locale: 'en' };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const done = await withMemberCtx(member, async (ctx) => {
          const d = await properties.getListing(ctx, e.id);
          if (d.price?.amountCents !== e.droppedCents) return false;
          await properties.updateListing(
            ctx,
            e.id,
            UpdateListingBody.parse({ version: d.version, priceCents: e.originalCents }),
          );
          return true;
        });
        if (done) out.restored++;
        else out.untouched++;
        return;
      } catch (err) {
        if ((err as { code?: string }).code === 'VERSION_CONFLICT' && attempt === 0) continue;
        if ((err as { code?: string }).code === 'LISTING_NOT_FOUND') {
          out.untouched++;
          return;
        }
        out.failed++;
        log.warn({ err, listingId: e.id }, 'storm price restore failed');
        return;
      }
    }
  });
  return out;
}

async function activeProfiles(): Promise<number> {
  const [r] = await system<{ n: number }>(
    'profiles',
    sql`select count(*)::int as n from saved_searches where frequency <> 'OFF'`,
  );
  return Number(r?.n ?? 0);
}

/** Mulberry32: a small deterministic PRNG for the provisioned profiles' shapes. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * `count` saved searches over every scale-seed agency (its admin saves them), shaped like agents' client profiles:
 * 30 % own stock, 50 % network, 20 % both; mostly sales; a place of the seeded listings for most; a budget and a
 * bedroom minimum for many. Keys from `matching.searchKeys` (the service's own). `PROVISIONED_FREQUENCY` (DAILY), so
 * the run sends no instant alert or notification to synthetic users. ≤ `PROVISION_BATCH` rows per statement.
 */
async function provisionProfiles(count: number, name: string): Promise<number> {
  const owners = await loadTestAgencies(100_000);
  if (owners.length === 0) throw new Error('no scale-seed agencies to own the client profiles');
  const places = (
    await system<{ id: string }>(
      'places',
      sql`select l::text as id from (select location_ids from listing_search_docs limit 20000) d, unnest(d.location_ids) l
           group by l limit 2000`,
    )
  ).map((r) => r.id);
  const random = rng(16_01);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)] as T;
  let written = 0;
  while (written < count) {
    const n = Math.min(PROVISION_BATCH, count - written);
    const rows = Array.from({ length: n }, (_, k) => {
      const owner = owners[(written + k) % owners.length] as (typeof owners)[number];
      const r = random();
      const scope = r < 0.3 ? 'OWN' : r < 0.8 ? 'NETWORK' : 'ALL';
      const transactionType = random() < 0.8 ? 'SALE' : null;
      const locationIds = places.length > 0 && (scope !== 'OWN' || random() < 0.4) ? [pick(places)] : [];
      return {
        id: newId(),
        agency_id: owner.agencyId,
        user_id: owner.userId,
        name,
        scope,
        frequency: PROVISIONED_FREQUENCY,
        transaction_type: transactionType,
        location_ids: `{${locationIds.join(',')}}`,
        price_max_cents: random() < 0.7 ? (200_000 + Math.floor(random() * 1_800_000)) * 100 : null,
        beds_min: random() < 0.5 ? 1 + Math.floor(random() * 4) : null,
        match_keys: `{${matching.searchKeys({ agencyId: owner.agencyId, scope, transactionType, locationIds }, true).join(',')}}`,
      };
    });
    await withSystem(`${REASON}.provision`, (tx) =>
      tx.execute(sql`
        insert into saved_searches (id, agency_id, user_id, name, scope, frequency, transaction_type, location_ids,
                                    price_max_cents, beds_min, match_keys)
        select id, agency_id, user_id, name, scope, frequency, transaction_type, location_ids::uuid[], price_max_cents,
               beds_min, match_keys::text[]
          from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
            as x(id uuid, agency_id uuid, user_id uuid, name text, scope text, frequency text, transaction_type text,
                 location_ids text, price_max_cents bigint, beds_min int, match_keys text)`),
    );
    written += n;
    if (written % 100_000 < PROVISION_BATCH) log.info({ written, count }, 'provisioning client profiles');
  }
  await system('analyze', sql`analyze saved_searches`).catch((err) => log.warn({ err }, 'analyze skipped'));
  return written;
}

/** Deletes the run's provisioned profiles (their alerts cascade), ≤ `PROVISION_BATCH` per statement. */
async function deleteProfiles(name: string): Promise<number> {
  let deleted = 0;
  for (;;) {
    const rows = await system<{ id: string }>(
      'deprovision',
      sql`delete from saved_searches where id in (select id from saved_searches where name = ${name}
           limit ${PROVISION_BATCH}) returning id`,
    );
    deleted += rows.length;
    if (rows.length < PROVISION_BATCH) return deleted;
  }
}

/**
 * `changes` active, priced listings with a search document (so matching sees a read model), an even share per agency
 * and interleaved across agencies, so the paced changes spread over every tenant from the start. One statement.
 */
async function stormListings(agencyIds: readonly string[], changes: number): Promise<StormListing[]> {
  const quota = Math.ceil(changes / agencyIds.length);
  const rows = await system<{ id: string; agency_id: string; price_cents: string; version: number; n: number }>(
    'listings',
    sql`select x.id, x.agency_id, x.price_cents::text, x.version, x.n
          from unnest(${uuids(agencyIds)}) as a(id)
          cross join lateral (
            select p.id, p.agency_id, p.price_cents, p.version, row_number() over (order by d.target_id) as n
              from listing_search_docs d join properties p on p.id = d.target_id
             where d.owner_agency_id = a.id and d.status = 'ACTIVE' and p.status = 'ACTIVE' and p.deleted_at is null
               and p.price_cents >= 1000000
             order by d.target_id limit ${quota}) x
         order by x.n, x.agency_id`,
  );
  return rows.slice(0, changes).map((r) => ({
    id: r.id,
    agencyId: r.agency_id,
    priceCents: Number(r.price_cents),
    version: Number(r.version),
  }));
}

/* ------------------------------------------------------------------ cleanup + main */

async function cleanup(): Promise<void> {
  const [c] = await system<{ n: number }>(
    'cleanup',
    sql`with d as (delete from feed_connections where name like ${`${CONNECTION_NAME} %`} returning 1)
        select count(*)::int as n from d`,
  );
  let profiles = 0;
  for (;;) {
    const rows = await system<{ id: string }>(
      'cleanup',
      sql`delete from saved_searches where id in (select id from saved_searches where name like ${`${PROFILE_NAME} %`}
           limit ${PROVISION_BATCH}) returning id`,
    );
    profiles += rows.length;
    if (rows.length < PROVISION_BATCH) break;
  }
  // S16-F4: seeded connections an interrupted import storm left on: their seeded URLs from its journal, then off
  let urlsRestored = 0;
  const feedJournals = existsSync(DATA_DIR) ? readdirSync(DATA_DIR).filter((f) => FEED_JOURNAL.test(f)) : [];
  for (const f of feedJournals) {
    const path = join(DATA_DIR, f);
    const { entries } = JSON.parse(readFileSync(path, 'utf8')) as { entries: { id: string; url: string }[] };
    urlsRestored += await restoreSeededConnections(entries);
    rmSync(path, { force: true });
  }
  const [off] = await system<{ n: number }>(
    'cleanup',
    sql`with u as (update feed_connections
                      set enabled = false, next_run_at = null, accept_anomaly_once = false, updated_at = now()
                    where name = ${SEEDED_FEED_NAME} and (enabled or next_run_at is not null) returning 1)
        select count(*)::int as n from u`,
  );
  log.info(
    { connections: c?.n ?? 0, profiles, seededUrlsRestored: urlsRestored, seededTurnedOff: off?.n ?? 0 },
    'storm leftovers removed',
  );

  // Prices an interrupted matching storm dropped: every journal left in tests/load/.data, removed once restored.
  const journals = existsSync(DATA_DIR) ? readdirSync(DATA_DIR).filter((f) => PRICE_JOURNAL.test(f)) : [];
  for (const f of journals) {
    const path = join(DATA_DIR, f);
    const { entries } = JSON.parse(readFileSync(path, 'utf8')) as { entries: PriceJournalEntry[] };
    const r = await restorePrices(entries);
    log.info({ journal: f, ...r }, 'storm prices restored');
    if (r.failed === 0) rmSync(path, { force: true });
  }

  if (values.listings) log.info({ deleted: await deleteStormListings() }, 'STORM-* listings deleted');
}

/**
 * Deletes the import storm's listings (`STORM-<feed>-<i>` references) of every verified scale-seed agency through
 * `properties.deleteListing` as the agency's admin — the soft delete a member makes (the listing leaves the network,
 * websites and search at once; the purge job removes it after the restore window). Found per agency on the
 * `(agency_id, ref_key collate "C")` index, `PROVISION_BATCH` at a time.
 */
async function deleteStormListings(): Promise<number> {
  const admins = new Map((await loadTestAgencies(100_000)).map((a) => [a.agencyId, a.userId]));
  if (admins.size === 0) return 0;
  let deleted = 0;
  let failed = 0;
  const skip = new Set<string>();
  for (;;) {
    const rows = await system<{ id: string; agency_id: string }>(
      'storm-listings',
      sql`select p.id, p.agency_id
            from unnest(${uuids([...admins.keys()])}) as a(id)
            cross join lateral (
              select id, agency_id from properties
               where agency_id = a.id and (ref_key collate "C") >= 'STORM-' and (ref_key collate "C") < 'STORM.'
                 and deleted_at is null and not (id = any(${uuids([...skip])}))
               limit ${PROVISION_BATCH}) p
           limit ${PROVISION_BATCH}`,
    );
    if (rows.length === 0) break;
    await eachLimit(rows, CLEANUP_CONCURRENCY, async (r) => {
      const member = {
        userId: admins.get(r.agency_id) as string,
        agencyId: r.agency_id,
        requestId: newId(),
        locale: 'en',
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await withMemberCtx(member, (ctx) => properties.deleteListing(ctx, r.id));
          deleted++;
          return;
        } catch (err) {
          if ((err as { code?: string }).code === 'VERSION_CONFLICT' && attempt === 0) continue;
          failed++;
          skip.add(r.id);
          log.warn({ err, listingId: r.id }, 'STORM-* listing not deleted');
          return;
        }
      }
    });
    log.info({ deleted, failed }, 'deleting STORM-* listings');
  }
  return deleted;
}

function writeOut(report: object): void {
  if (!values.out) return;
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, JSON.stringify(report, null, 2));
}

let pass = false;
try {
  if (!['import', 'matching', 'cleanup'].includes(scenario ?? '')) {
    throw new Error('usage: storm import|matching|cleanup [--test|--staging] [--profile smoke|staging] …');
  }
  assertLoadTarget(process.env, values.staging);
  const config = loadConfigOrExit(dbEnv);
  await configureDb(config, { logger: log });
  if (process.env.REDIS_QUEUE_URL) await configureQueue({ url: process.env.REDIS_QUEUE_URL, logger: log });
  // the listing service's side reads (cached lookups) and DTOs (media URLs), as the api configures them
  if (process.env.REDIS_CACHE_URL) await configureCache({ url: process.env.REDIS_CACHE_URL, logger: log });
  if (process.env.MEDIA_URL_KEY) media.configureMedia({ urlKey: process.env.MEDIA_URL_KEY });
  if (scenario === 'cleanup') {
    await cleanup();
    pass = true;
  } else {
    pass = scenario === 'import' ? await importStorm(values.staging) : await matchingStorm(values.staging);
  }
} catch (err) {
  log.error({ err }, 'storm failed');
} finally {
  await closeQueues().catch(() => {});
  await closeCache().catch(() => {});
  await closeDb();
  process.exitCode = pass ? 0 : 1;
}
