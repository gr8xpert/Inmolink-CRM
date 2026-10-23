import { execFile, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { CreatePortalConnectionBody } from '@inmolink/contracts';
import { withMemberCtx } from '@inmolink/core';
import * as agenciesModule from '@inmolink/core/modules/agencies';
import * as exportsModule from '@inmolink/core/modules/exports';
import { DEFAULT_PORTAL_FEED_JOBS, exportsJobs, PORTAL_FEED_TIMEOUT_MS } from '@inmolink/core/modules/exports/worker';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { loadConfig, storageEnv } from '@inmolink/platform/config';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { configureStorage, createS3Store, storage, storageConfigFromEnv } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { listingDoc } from '../../packages/core/src/modules/exports/__tests__/portal-fixtures';

/**
 * Nightly portal feed regeneration at size (S9-03 acceptance: 5,000 feeds within 60 minutes on the scale seed without
 * starving other pools; worker RSS < 512 MB). The 5,000-agency scale seed (2M listings) does not fit this machine's
 * Docker (8 GB, Postgres capped), so this test measures a locally feasible slice and extrapolates:
 *
 * - `PORTAL_FEED_PERF_AGENCIES` (default 60) verified agencies × `PORTAL_FEED_PERF_ROWS` (default 400 — the scale
 *   seed's 2M / 5,000 average) ACTIVE, PUBLIC listings each, with a read model (a complete document, six photos) in the
 *   agency's content locale; every agency has a Kyero connection and every fifth also a generic-XML one (one pass
 *   writes both).
 * - One large agency (20,000 listings, one Kyero connection) is generated alone: its pass must stay within the job's
 *   `timeoutMs` and the RSS budget.
 * - The passes run in worker-like child processes on the built packages (`portal-feeds.child.ts`, 2 passes at once
 *   each: the per-process cap), streaming gzip to the test stack's MinIO, at 2, 4 and 8 concurrent passes (1, 2 and 4
 *   processes), every file changed each time; then an unchanged night at 8 (nothing rewritten: content hash). With
 *   `PORTAL_FEED_PERF_RESTART=<postgres container>` the container is restarted after the seed, so the first phase
 *   starts with Postgres' shared buffers cold (the Docker VM's page cache stays warm).
 *
 * Extrapolation (stated in the log and STATUS): projected minutes = 5,000 × the mean pass time measured at 8 concurrent
 * passes ÷ `nightlyLanes` (6: the night's concurrency) ÷ 60 — the 8-pass time is no faster than the 6-lane one. Assumes
 * the scale seed's per-agency size is the average (the large agency is checked separately). Locally the 8-pass phase
 * saturates this machine (Postgres at 4 CPUs and four Node processes share it), so its pass time is an upper bound
 * here. The staging run on the real scale seed is H4 (see STATUS).
 */

const log = createLogger({ service: 'perf', level: 'info' });
const RUN = newId().slice(-8);
const AGENCIES = Number(process.env.PORTAL_FEED_PERF_AGENCIES ?? 60);
const ROWS = Number(process.env.PORTAL_FEED_PERF_ROWS ?? 400);
const TARGET_FEEDS = 5_000;
const BUDGET_MINUTES = 60;
const RSS_BUDGET_MB = 512;
const REF = /^PF[0-9]{5}$/;
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('perf.portal-feeds', fn);
const exec = (q: ReturnType<typeof sql>) =>
  system(async (tx) => {
    await tx.execute(sql`set local statement_timeout = 0`);
    return tx.execute(q);
  });

let founders: Founder[] = [];
/** One large agency (20,000 listings): its pass must stay within the job's time limit and the RSS budget. */
let big: Founder;
const BIG_ROWS = 20_000;
/**
 * Statements of one pass of a 2-connection, 400-listing agency (asserted exactly, S9-03 review), from the measured
 * list (`statementList` in the log): the plan 3 (connections; owner locales; presenter) + two full rounds of 7 (per
 * connection its selection page, 2 statements, and its issue sync, 1; the documents once) + the closing round 4 (per
 * connection an empty selection page, 1, and its issue sync, 1) + the run record 3 (connections, history, retention).
 */
const EXPECTED_STATEMENTS = 3 + 2 * 7 + 4 + 3;
const connections: string[] = [];

async function cleanup(): Promise<void> {
  await exec(
    sql`delete from listing_read_models where target_id in (select id from properties where ref ~ ${REF.source})`,
  );
  await exec(sql`delete from properties where ref ~ ${REF.source}`);
}

async function deleteObjects(): Promise<void> {
  for (const id of connections) {
    const page = await storage().list('feeds', exportsModule.portalFeedPrefix(id), { limit: 1_000 });
    for (const o of page.objects) await storage().delete('feeds', o.key);
  }
}

beforeAll(async () => {
  await setupTestDb('worker');
  configureStorage(createS3Store(storageConfigFromEnv(loadConfig(storageEnv))));
  exportsModule.configureExports({
    keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }),
    tokenKey: 'test-hmac-key-0123456789abcdef0123456789',
  });
  await cleanup();
  await system((tx) => exportsModule.syncPortalChannels(tx));
  founders = [];
  for (let i = 0; i < AGENCIES; i++) founders.push(await createFounder());
  big = await createFounder();
  for (const f of [...founders, big]) await setAgencyStatus(f.agencyId, 'VERIFIED');
  const ids = await system(async (tx) => {
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('perf-pf'),
      translations: tr(`Portalia ${RUN}`, 'portalia'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('perf-pf-g'),
      sort: 0,
      translations: tr(`Homes ${RUN}`, 'perf-pf-g'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('perf-pf-t'),
      sort: 0,
      translations: tr(`Villa ${RUN}`, 'perf-pf-t'),
    });
    return { country, type };
  });
  const locale =
    (await system((tx) => agenciesModule.readModelOwnersOf(tx, [founders[0]?.agencyId as string])))
      .get(founders[0]?.agencyId as string)
      ?.locales.at(0) ?? 'es';
  const template = JSON.stringify(listingDoc());
  const started = performance.now();
  const seed = (f: Founder, rows: number) =>
    exec(sql`
      with l as (
        insert into properties (id, agency_id, owner_user_id, ref, status, visibility, transaction_type, price_cents,
                                bedrooms, bathrooms, built_m2, energy_rating, lat, lng, property_type_id, location_id,
                                country_id)
        select gen_random_uuid(), ${f.agencyId}, ${f.userId}, 'PF' || lpad(i::text, 5, '0'), 'ACTIVE', 'PUBLIC', 'SALE',
               10000000 + i::bigint * 100000, i % 6, i % 4, 80 + i % 300, 'C', 36.5, -4.9, ${ids.type}, ${ids.country},
               ${ids.country}
          from generate_series(1, ${rows}) as i
        returning id, agency_id, ref
      )
      insert into listing_read_models (target_id, locale, kind, agency_id, public, status, version, card, detail, etag)
      select l.id, ${locale}, 'LISTING', l.agency_id, true, 'ACTIVE', 1, '{}'::jsonb,
             ${template}::jsonb || jsonb_build_object('id', l.id, 'ref', l.ref), 'e' || l.id
        from l`);
  for (const f of founders) await seed(f, ROWS);
  await seed(big, BIG_ROWS);
  await exec(sql`analyze properties`);
  await exec(sql`analyze listing_read_models`);
  const connect = async (f: Founder, channelCode: string) => {
    const created = await withMemberCtx(
      { userId: f.userId, agencyId: f.agencyId, requestId: newId(), locale: 'en' },
      (ctx) =>
        exportsModule.createConnection(
          ctx,
          CreatePortalConnectionBody.parse({ channelCode, name: `Perf ${channelCode}` }),
        ),
    );
    connections.push(created.connection.id);
  };
  for (const [i, f] of founders.entries()) {
    for (const channelCode of i % 5 === 0 ? ['kyero', 'generic-xml'] : ['kyero']) await connect(f, channelCode);
  }
  await connect(big, 'kyero');
  log.info(
    {
      agencies: AGENCIES,
      rows: ROWS,
      bigAgencyRows: BIG_ROWS,
      connections: connections.length,
      seedSeconds: (performance.now() - started) / 1_000,
    },
    'portal feed perf seeded',
  );
}, 30 * 60_000);

afterAll(async () => {
  await deleteObjects().catch(() => undefined);
  await cleanup().catch(() => undefined);
  // The connections too: the shared test database's nightly sweeps must not walk these agencies.
  await exec(sql`delete from agency_portal_connections where id in ${connections}`).catch(() => undefined);
  await closeDb();
});

interface ChildResult {
  base: number;
  peak: number;
  seconds: number;
  passes: { ms: number; written: number; unchanged: number; failed: number }[];
}

/** Passes over these agencies in a worker-like process of its own (built packages), `concurrency` at a time. */
function child(agencyIds: readonly string[], concurrency: number): Promise<ChildResult> {
  const script = join(import.meta.dirname, 'portal-feeds.child.ts');
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', script, agencyIds.join(','), String(concurrency)],
      {
        encoding: 'utf8',
        timeout: 20 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, APP_ROLE: 'worker' },
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`portal feed child failed: ${String(stderr).slice(-2_000)}`));
        else resolve(JSON.parse(stdout.trim().split(String.fromCharCode(10)).pop() as string) as ChildResult);
      },
    );
  });
}

/**
 * `passes` concurrent passes over these agencies: `passes / runsPerProcess` worker-like processes at once, each at the
 * per-process cap — the pool at that size.
 */
async function pool(agencyIds: readonly string[], passes: number, perProcess: number) {
  const processes = Math.max(1, Math.round(passes / perProcess));
  const slices = Array.from({ length: processes }, (_, i) => agencyIds.filter((_, j) => j % processes === i));
  const started = performance.now();
  const results = await Promise.all(slices.map((ids) => child(ids, perProcess)));
  return {
    passes,
    seconds: (performance.now() - started) / 1_000,
    runs: results.flatMap((r) => r.passes),
    peak: Math.max(...results.map((r) => r.peak)),
    base: Math.min(...results.map((r) => r.base)),
  };
}

const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const mb = (n: number) => Math.round(n / 1_048_576);
const sum = (runs: ChildResult['passes'], k: 'written' | 'unchanged' | 'failed') => runs.reduce((s, p) => s + p[k], 0);
/** Every listing's document changes (a new file for every connection). */
const touch = (beds: number) =>
  exec(sql`update listing_read_models set detail = jsonb_set(detail, '{bedrooms}', ${String(beds)}::jsonb),
                  updated_at = now()
            where target_id in (select id from properties where ref ~ ${REF.source})`);

it(
  '[S9-03] 5,000 feeds regenerate nightly within 60 min (measured at 2, 4 and 8 concurrent passes, extrapolated) within the worker RSS budget',
  async () => {
    const agencyIds = founders.map((f) => f.agencyId);
    const caps = DEFAULT_PORTAL_FEED_JOBS;
    const small = connections.length - 1;
    // Fair share and pool caps (so other pools and tenants keep their share): one pass per agency at a time, the night
    // in `nightlyLanes` chains (< the pool-wide cap), at most `runsPerProcess` heavy jobs per process (S9 review: passes,
    // push runs and site feeds together, one cap group).
    expect(exportsJobs.generatePortalFeeds.spec.concurrencyPerGroup).toBe(1);
    expect(exportsJobs.generateNightlyPortalFeeds.spec.concurrencyPerGroup).toBe(1);
    expect(
      [exportsJobs.generatePortalFeeds, exportsJobs.generateNightlyPortalFeeds, exportsJobs.pushPortalListings].map(
        (j) => j.spec.capGroup,
      ),
    ).toEqual(Array(3).fill(websiteApi.EXPORTS_FEED_CAP_GROUP));
    expect(caps).toMatchObject({ nightlyLanes: 6, maxConcurrentRuns: 8, runsPerProcess: 2 });

    // 1. The first night, 2 passes at once — with Postgres' shared buffers cold when `PORTAL_FEED_PERF_RESTART` names the
    // test container (local runs only: restarted after the seed; the Docker VM's page cache stays warm).
    const container = process.env.PORTAL_FEED_PERF_RESTART;
    if (container) {
      await closeDb();
      execFileSync('docker', ['restart', container], { timeout: 120_000 });
      for (let i = 0; i < 120; i++) {
        const health = execFileSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', container], {
          encoding: 'utf8',
        }).trim();
        if (health === 'healthy') break;
        await new Promise((r) => setTimeout(r, 1_000));
      }
      await setupTestDb('worker');
    }
    const p2 = await pool(agencyIds, 2, caps.runsPerProcess);
    expect(sum(p2.runs, 'written')).toBe(small);
    expect(sum(p2.runs, 'failed')).toBe(0);
    // 2. Every file changed, 4 passes at once (two processes).
    await touch(5);
    const p4 = await pool(agencyIds, 4, caps.runsPerProcess);
    expect(sum(p4.runs, 'written')).toBe(small);
    // 3. Every file changed, 8 passes at once (four processes: the pool-wide cap).
    await touch(4);
    const p8 = await pool(agencyIds, 8, caps.runsPerProcess);
    expect(sum(p8.runs, 'written')).toBe(small);
    // 4. An unchanged night at 8: nothing rewritten (content hash).
    const quiet = await pool(agencyIds, 8, caps.runsPerProcess);
    expect(sum(quiet.runs, 'unchanged')).toBe(small);
    expect(sum(quiet.runs, 'written')).toBe(0);
    for (const phase of [p2, p4, p8, quiet]) expect(mb(phase.peak)).toBeLessThan(RSS_BUDGET_MB);

    // 5. The large agency (20,000 listings) alone: within the job's time limit and the RSS budget.
    const large = await child([big.agencyId], 1);
    const largeMs = large.passes[0]?.ms ?? Number.POSITIVE_INFINITY;
    expect(large.passes[0]).toMatchObject({ written: 1, failed: 0 });
    expect(largeMs).toBeLessThan(PORTAL_FEED_TIMEOUT_MS);
    expect(mb(large.peak)).toBeLessThan(RSS_BUDGET_MB);

    // Statements of one pass (this process): founders[0] has 2 connections and 400 listings (2 rounds of 200). The plan
    // (connections, owner, presenter), per round one selection page per connection (2 statements each), one document
    // statement for both, one issue sync per connection, then the run record (3 statements, whatever the count).
    const { generatePortalFeeds, configurePortalFeeds } = await import('@inmolink/core/modules/exports/worker');
    configurePortalFeeds({ mediaBaseUrl: 'https://media.example' });
    const statements: string[] = [];
    await countQueries(() => generatePortalFeeds(founders[0]?.agencyId as string, { trigger: 'EVENT' }), {
      onQuery: (q) => statements.push(q.replace(/\s+/g, ' ').slice(0, 80)),
    });

    const passSeconds = (phase: { runs: ChildResult['passes'] }) => mean(phase.runs.map((p) => p.ms)) / 1_000;
    // The night runs `nightlyLanes` (6) chains; its pass time is taken at 8 concurrent passes (no faster than at 6).
    const lanes = caps.nightlyLanes;
    const projectedMinutes = (TARGET_FEEDS * passSeconds(p8)) / lanes / 60;
    const projectedQuietMinutes = (TARGET_FEEDS * passSeconds(quiet)) / lanes / 60;
    log.info(
      {
        agencies: AGENCIES,
        listingsPerAgency: ROWS,
        connections: small,
        meanPassMs: {
          concurrent2Cold: Math.round(passSeconds(p2) * 1_000),
          concurrent4: Math.round(passSeconds(p4) * 1_000),
          concurrent8: Math.round(passSeconds(p8) * 1_000),
          concurrent8Unchanged: Math.round(passSeconds(quiet) * 1_000),
        },
        wallSeconds: {
          concurrent2: Math.round(p2.seconds * 10) / 10,
          concurrent4: Math.round(p4.seconds * 10) / 10,
          concurrent8: Math.round(p8.seconds * 10) / 10,
          concurrent8Unchanged: Math.round(quiet.seconds * 10) / 10,
        },
        largeAgency: { listings: BIG_ROWS, passSeconds: Math.round(largeMs / 100) / 10, rssPeakMb: mb(large.peak) },
        statementsPerPass: statements.length,
        statementList: statements,
        rssMb: { idle: mb(p2.base), peak: mb(Math.max(p2.peak, p4.peak, p8.peak, quiet.peak)) },
        projection: {
          feeds: TARGET_FEEDS,
          nightlyLanes: lanes,
          minutesChanged: Math.round(projectedMinutes * 10) / 10,
          minutesUnchanged: Math.round(projectedQuietMinutes * 10) / 10,
        },
      },
      'portal feeds: nightly throughput',
    );
    expect(statements).toHaveLength(EXPECTED_STATEMENTS);
    expect(projectedMinutes).toBeLessThan(BUDGET_MINUTES);
  },
  60 * 60_000,
);
