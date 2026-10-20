import { CreateFeedConnectionBody, type FeedConnectionDto, type FeedListingInput } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { createStaffUser, setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { withStaffCtx } from '../../../staff';
import { createFounder, type Founder } from '../../../testing/factories';
import * as taxonomy from '../../taxonomy';
import * as imports from '../index';
import { memoryConnector } from './test-connectors';

/**
 * S6-08: the anomaly guard (spike, mass withdrawal → pause + event; resume, "accept the change"), freshness via feed
 * (a run confirms listings while the feed shows signs of life within IMPORT_FEED_FRESHNESS_DAYS) and the staff import
 * health dashboard. Real loader, real database; feeds served from memory.
 */

const RUN = newId().slice(-8).toLowerCase();
const log = createLogger({ service: 'imports-guard-test', level: 'silent' });
const job = () => ({ log, signal: new AbortController().signal, lastAttempt: true });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('imports.guard.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: `${slug}-${RUN}` }];

let owner: Founder;
let dataOps: string;
let support: string;
const undo: (() => void)[] = [];
const feeds = new Map<string, FeedListingInput[]>();
const names = {
  country: `Guardia ${RUN}`,
  region: `Costa Guard ${RUN}`,
  city: `Villa Guard ${RUN}`,
  type: `Guard Villa ${RUN}`,
};

const as = <T>(fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: owner.userId, agencyId: owner.agencyId, requestId: newId(), locale: 'en' }, fn);
const asStaff = <T>(userId: string, fn: Parameters<typeof withStaffCtx<T>>[1]) =>
  withStaffCtx({ userId, requestId: newId(), reason: 'imports guard test' }, fn);

function listing(ref: string, price = 300_000_00): FeedListingInput {
  return {
    ref,
    transactionType: 'SALE',
    priceCents: price,
    bedrooms: 2,
    propertyType: names.type,
    location: { country: names.country, region: names.region, city: names.city },
    features: [],
    translations: [{ locale: 'en', title: `Home ${ref}`, description: null }],
  };
}
const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => listing(`${prefix}-${i}`));

async function connection(
  settings: Record<string, string | number> = {},
): Promise<FeedConnectionDto & { key: string }> {
  const key = `grd-${newId().slice(-10).toLowerCase()}`;
  feeds.set(key, []);
  undo.push(imports.registerConnector(memoryConnector(key, () => feeds.get(key) ?? [])));
  const c = await as((ctx) =>
    imports.createFeedConnection(
      ctx,
      CreateFeedConnectionBody.parse({
        name: 'Guarded feed',
        connector: key,
        url: 'https://feeds.example.com/guard.xml',
        scheduleMinutes: null,
        settings,
      }),
    ),
  );
  return { ...c, key };
}

async function runFeed(c: { id: string; key: string }, items: FeedListingInput[]) {
  feeds.set(c.key, items);
  const run = await as((ctx) => imports.requestFeedRun(ctx, c.id));
  await imports.executeRun({ runId: run.id, agencyId: owner.agencyId }, job());
  return as((ctx) => imports.getFeedRun(ctx, run.id));
}

const statuses = async (c: { id: string }) =>
  rows<{ external_ref: string; status: string; import_missed_runs: number }>(sql`
    select pp.external_ref, p.status, pp.import_missed_runs
      from properties p join property_privates pp on pp.property_id = p.id
     where pp.import_connection_id = ${c.id}`);

beforeAll(async () => {
  await setupTestDb('worker');
  imports.configureImports({
    keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }),
    withdrawAfterMissedRuns: 3,
    anomalySpikeFactor: 5,
    anomalyDropRatio: 0.3,
    feedFreshnessDays: 120,
  });
  owner = await createFounder();
  dataOps = (await createStaffUser('STAFF_DATA_OPS')).userId;
  support = (await createStaffUser('STAFF_SUPPORT')).userId;
  await system(async (tx) => {
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `gd-c-${RUN}`,
      translations: tr(names.country, 'guardia'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: `gd-r-${RUN}`,
      translations: tr(names.region, 'costa-guard'),
    });
    await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: `gd-ci-${RUN}`,
      translations: tr(names.city, 'villa-guard'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `gd-houses-${RUN}`,
      sort: 0,
      translations: tr(`Guard Houses ${RUN}`, 'guard-houses'),
    });
    await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `gd-villa-${RUN}`,
      sort: 0,
      translations: tr(names.type, 'guard-villa'),
    });
  });
}, 120_000);

afterAll(async () => {
  for (const u of undo) u();
  await closeDb();
});

describe('import anomaly guard', () => {
  it('[S6-08] a feed that suddenly drops 40% of its listings pauses instead of withdrawing them; resume, accept the change, then it withdraws', async () => {
    // N = 1: without the guard the very next run would withdraw every missing listing
    const c = await connection({ withdrawAfterMissedRuns: 1 });
    const all = many('D', 20);
    expect((await runFeed(c, all)).counts).toMatchObject({ created: 20 });

    const kept = all.slice(0, 12); // 8 of 20 gone at once: 40%
    const paused = await runFeed(c, kept);
    expect(paused).toMatchObject({ state: 'FAILED', errorCode: 'FEED_PAUSED_MASS_WITHDRAWAL' });
    expect(paused.counts.withdrawn).toBe(0);
    let stored = await statuses(c);
    expect(stored.filter((s) => s.status === 'ACTIVE')).toHaveLength(20);
    expect(stored.every((s) => s.import_missed_runs === 0)).toBe(true); // no miss counted either

    const conn = await as((ctx) => imports.getFeedConnection(ctx, c.id));
    expect(conn.pause).toMatchObject({
      reason: 'MASS_WITHDRAWAL',
      runId: paused.id,
      details: { missing: 8, live: 20 },
    });
    const [event] = await rows<{ payload: { reason: string } }>(sql`
      select payload from outbox_events where type = 'imports.connection.paused'
         and agency_id = ${owner.agencyId} and payload->>'connectionId' = ${c.id}`);
    expect(event?.payload.reason).toBe('MASS_WITHDRAWAL');
    // durable: "run now" is refused, and the scheduler's due query skips it
    await expect(as((ctx) => imports.requestFeedRun(ctx, c.id))).rejects.toMatchObject({
      code: 'FEED_CONNECTION_PAUSED',
    });
    await system((tx) =>
      tx.execute(sql`update feed_connections set next_run_at = now() - interval '1 minute',
      schedule_minutes = 60 where id = ${c.id}`),
    );
    const [due] = await rows<{ n: number }>(sql`select count(*)::int as n from feed_connections
      where id = ${c.id} and enabled and next_run_at <= now() and paused_at is null`);
    expect(due?.n).toBe(0);
    await system((tx) =>
      tx.execute(sql`update feed_connections set next_run_at = null, schedule_minutes = null
      where id = ${c.id}`),
    );

    // resumed without accepting: the same drop pauses again
    await as((ctx) => imports.resumeFeedConnection(ctx, c.id, { acceptChange: false }));
    expect(await runFeed(c, kept)).toMatchObject({ errorCode: 'FEED_PAUSED_MASS_WITHDRAWAL' });

    // resumed accepting the change: the next run withdraws (N = 1), and the acceptance is used up
    const resumed = await as((ctx) => imports.resumeFeedConnection(ctx, c.id, { acceptChange: true }));
    expect(resumed).toMatchObject({ pause: null, acceptAnomalyOnce: true });
    const accepted = await runFeed(c, kept);
    expect(accepted).toMatchObject({ state: 'SUCCEEDED', counts: { withdrawn: 8 } });
    stored = await statuses(c);
    expect(stored.filter((s) => s.status === 'WITHDRAWN')).toHaveLength(8);
    expect((await as((ctx) => imports.getFeedConnection(ctx, c.id))).acceptAnomalyOnce).toBe(false);
  });

  it('[S6-08] a feed that swaps 40% of its references pauses too: the listings it creates are not part of the base', async () => {
    const c = await connection({ withdrawAfterMissedRuns: 1 });
    const all = many('S', 20);
    await runFeed(c, all);
    const swapped = await runFeed(c, [...all.slice(0, 12), ...many('SN', 8)]);
    expect(swapped).toMatchObject({ state: 'FAILED', errorCode: 'FEED_PAUSED_MASS_WITHDRAWAL' });
    const conn = await as((ctx) => imports.getFeedConnection(ctx, c.id));
    expect(conn.pause?.details).toMatchObject({ missing: 8, live: 20 });
    expect((await statuses(c)).filter((x) => x.status === 'WITHDRAWN')).toHaveLength(0);
  });

  it('[S6-08] a run with more than 5× the typical volume stops before writing past the line and pauses', async () => {
    const c = await connection();
    const base = many('V', 25);
    for (let i = 0; i < 3; i++) await runFeed(c, base); // typical volume 25
    const spike = await runFeed(c, [...base, ...many('VX', 175)]); // 200 > 5 × 25
    expect(spike).toMatchObject({ state: 'FAILED', errorCode: 'FEED_PAUSED_VOLUME_SPIKE' });
    expect(spike.counts.created).toBe(0); // one batch of 500: stopped before it was written
    expect(await statuses(c)).toHaveLength(25);
    const conn = await as((ctx) => imports.getFeedConnection(ctx, c.id));
    expect(conn.pause).toMatchObject({ reason: 'VOLUME_SPIKE', details: { items: 200, typical: 25, factor: 5 } });

    await as((ctx) => imports.resumeFeedConnection(ctx, c.id, { acceptChange: true }));
    const accepted = await runFeed(c, [...base, ...many('VX', 175)]);
    expect(accepted).toMatchObject({ state: 'SUCCEEDED', counts: { created: 175 } });
  });
});

describe('freshness via feed (user-approved 2026-10-19)', () => {
  const age = (c: { id: string }, days: number) =>
    system((tx) =>
      tx.execute(sql`update properties p set last_confirmed_at = now() - make_interval(days => ${days}),
          confirm_prompted_at = now() - interval '1 day'
        from property_privates pp where pp.property_id = p.id and pp.import_connection_id = ${c.id}`),
    );
  const freshness = (c: { id: string }) =>
    rows<{ days: number; prompted: boolean }>(sql`
      select extract(day from now() - p.last_confirmed_at)::int as days, p.confirm_prompted_at is not null as prompted
        from properties p join property_privates pp on pp.property_id = p.id where pp.import_connection_id = ${c.id}`);

  it('[S6-08] a successful run confirms the listings it lists while the feed changed within 120 days; a feed static for longer confirms nothing', async () => {
    const c = await connection();
    const items = many('F', 3);
    await runFeed(c, items); // created: the feed changed now

    await age(c, 100);
    const since = new Date();
    await runFeed(c, items); // unchanged items, but the feed showed life today
    expect((await freshness(c)).every((f) => f.days === 0 && !f.prompted)).toBe(true);
    const [events] = await rows<{ n: number }>(sql`select count(*)::int as n from outbox_events
      where type = 'properties.listings.imported' and agency_id = ${owner.agencyId}
        and created_at >= ${since.toISOString()}::timestamptz`);
    expect(events?.n).toBeGreaterThanOrEqual(1); // prompts cleared: search and quality rebuild them

    // byte-for-byte static for longer than IMPORT_FEED_FRESHNESS_DAYS: the run no longer confirms
    await system((tx) =>
      tx.execute(sql`update feed_connections set content_changed_at = now() - interval '121 days' where id = ${c.id}`),
    );
    await age(c, 100);
    expect(await runFeed(c, items)).toMatchObject({ state: 'SUCCEEDED' });
    expect((await freshness(c)).every((f) => f.days === 100 && f.prompted)).toBe(true);

    // one item changes: signs of life again, every listing in the run is confirmed
    await runFeed(c, [listing('F-0', 299_000_00), ...items.slice(1)]);
    expect((await freshness(c)).every((f) => f.days === 0 && !f.prompted)).toBe(true);
  });
});

describe('staff import health', () => {
  it('[S6-08] staff see runs, failures by code, queue lag, paused connections and unmatched values; data ops resume, support cannot', async () => {
    const c = await connection();
    const all = many('H', 20);
    await runFeed(c, all);
    await runFeed(c, all.slice(0, 10)); // 50% gone: paused

    const health = await asStaff(support, (ctx) => imports.getImportHealth(ctx));
    expect(health.windowHours).toBe(24);
    expect(health.runs.succeeded).toBeGreaterThanOrEqual(1);
    expect(health.runs.paused).toBeGreaterThanOrEqual(1);
    expect(health.failures.find((f) => f.code === 'FEED_PAUSED_MASS_WITHDRAWAL')?.count).toBeGreaterThanOrEqual(1);
    expect(health.paused.find((p) => p.connectionId === c.id)).toMatchObject({
      agencyId: owner.agencyId,
      pause: { reason: 'MASS_WITHDRAWAL', details: { missing: 10, live: 20 } },
    });
    expect(health.recentFailures.some((f) => f.connectionId === c.id)).toBe(true);
    expect(health.lag.maxWaitSeconds).toBeGreaterThanOrEqual(0);
    expect(Object.keys(health.unmatched).sort()).toEqual(['feature', 'location', 'propertyType']);

    await expect(
      asStaff(support, (ctx) => imports.staffResumeFeedConnection(ctx, c.id, { acceptChange: false })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const resumed = await asStaff(dataOps, (ctx) =>
      imports.staffResumeFeedConnection(ctx, c.id, { acceptChange: true }),
    );
    expect(resumed).toMatchObject({ pause: null, acceptAnomalyOnce: true });
    // column grants: staff never read a connection's URL or credentials, never change its URL
    await expect(
      asStaff(support, (ctx) => ctx.tx.execute(sql`select credentials_enc, url from feed_connections limit 1`)),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      asStaff(dataOps, (ctx) =>
        ctx.tx.execute(sql`update feed_connections set url = 'https://evil.example.com/' where id = ${c.id}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    const [audit] = await rows<{ actor_kind: string }>(sql`select actor_kind from audit_logs
      where type = 'staff.imports.resumed' and agency_id = ${owner.agencyId} and target_id = ${c.id}`);
    expect(audit?.actor_kind).toBe('staff');
  });
});
