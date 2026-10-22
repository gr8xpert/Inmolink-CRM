import { CreateFeedConnectionBody } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { SafeFetchError } from '@inmolink/platform/safe-fetch';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as taxonomy from '../../taxonomy';
import { RUNS } from '../config';
import * as imports from '../index';
import { createResalesConnector, type ResalesResponse } from '../resales/connector';
import type { RunOutcome } from '../runner';

/**
 * S7-F12: Resales Online runs in slices and resumed from their checkpoint, through the real loader. A large account
 * completes across slices with every page and every listing read once; the run's seen references survive the slices
 * (a listing that left the feed is withdrawn, the others are not); a timeout mid-run resumes from the last committed
 * page instead of starting over; a run whose connection changed, or whose seen references were lost, starts over; a
 * refused run keeps the API's own text. The API is a fake keyed by Client ID (one account per connection).
 */

const RUN = newId().slice(-8).toLowerCase();
const log = createLogger({
  service: 'resales-resume',
  level: (process.env.TEST_LOG as 'warn' | undefined) ?? 'silent',
});
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('imports.resales-resume.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const sfx = (s: string) => `${s} rr ${RUN}`;
const tr = (name: string) => [
  { locale: 'en', name: sfx(name), slug: `${name.toLowerCase().replaceAll(/[^a-z]+/g, '-')}-rr-${RUN}` },
];
const ok = (v: unknown): ResalesResponse => ({ status: 200, text: JSON.stringify(v) });
const PAGE = 40;

/** One fake Resales account per Client ID. */
interface Account {
  refs: string[];
  gone: Set<string>;
  /** Pages that time out (every attempt) while `times` lasts. */
  timeouts: Map<number, number>;
  refusal?: string;
  pages: number[];
  details: string[];
}
const accounts = new Map<string, Account>();
const account = (clientId: string, prefix: string, total: number): Account => {
  const a: Account = {
    refs: Array.from({ length: total }, (_, i) => `${prefix}${String(i + 1).padStart(6, '0')}`),
    gone: new Set(),
    timeouts: new Map(),
    pages: [],
    details: [],
  };
  accounts.set(clientId, a);
  return a;
};

const connector = createResalesConnector(
  async ({ url }) => {
    const u = new URL(url);
    const a = accounts.get(u.searchParams.get('p1') ?? '');
    if (!a) return { status: 500, text: '' };
    if (a.refusal) return ok({ transaction: { status: 'error', errordescription: { '1': a.refusal } }, QueryInfo: {} });
    const ref = u.searchParams.get('P_RefId');
    if (ref) {
      a.details.push(ref);
      return ok({ transaction: { status: 'success' }, Property: { Reference: ref, BuiltYear: '2010' } });
    }
    const page = Number(u.searchParams.get('P_PageNo'));
    const left = a.timeouts.get(page) ?? 0;
    if (left > 0) {
      a.timeouts.set(page, left - 1);
      throw new SafeFetchError('TIMEOUT', 'the request timed out');
    }
    a.pages.push(page);
    const present = a.refs.filter((r) => !a.gone.has(r));
    const Property = present.slice((page - 1) * PAGE, page * PAGE).map((r) => ({
      Reference: r,
      OwnProperty: '1',
      Country: 'Spain',
      Province: 'Málaga',
      Location: 'Marbella',
      PropertyType: { NameType: 'Detached Villa' },
      Price: '400,000',
      Description: `Villa ${r}.`,
    }));
    return ok({
      transaction: { status: 'success' },
      QueryInfo: { PropertyCount: present.length, PropertiesPerPage: PAGE, SearchType: 'Sale' },
      Property,
    });
  },
  { key: 'resales-resume', sleep: async () => {}, now: () => Date.now() },
);

let owner: Founder;
let undo: () => void;
const as = <T>(fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: owner.userId, agencyId: owner.agencyId, requestId: newId(), locale: 'en' }, fn);

async function connect(clientId: string): Promise<string> {
  const c = await as((ctx) =>
    imports.createFeedConnection(
      ctx,
      CreateFeedConnectionBody.parse({
        name: `Resales ${clientId}`,
        connector: 'resales-resume',
        url: 'https://webapi.resales-online.com/V6',
        credentials: { type: 'basic', username: clientId, password: 'k'.repeat(40) },
        scheduleMinutes: null,
        settings: { filterAlias: '1', languages: '' },
      }),
    ),
  );
  return c.id;
}

const job = (over: { lastAttempt?: boolean; sliceMarks?: number } = {}) => ({
  log,
  signal: new AbortController().signal,
  lastAttempt: over.lastAttempt ?? true,
  ...(over.sliceMarks ? { sliceMarks: over.sliceMarks } : {}),
});

/** One job of the run: its outcome, or the error a retryable failure re-threw for the job's next attempt. */
const slice = (runId: string, over: Parameters<typeof job>[0] = {}): Promise<RunOutcome | Error> =>
  imports.executeRun({ runId, agencyId: owner.agencyId }, job(over)).catch((e: unknown) => e as Error);

/** Jobs of a run until it finishes (each requeued slice is the next job). */
async function runToEnd(runId: string, sliceMarks: number): Promise<string[]> {
  const kinds: string[] = [];
  for (let i = 0; i < 50; i++) {
    const outcome = await slice(runId, { sliceMarks });
    if (outcome instanceof Error) throw outcome;
    kinds.push(outcome.kind);
    if (outcome.kind !== 'requeued') return kinds;
  }
  throw new Error('the run never finished');
}

type RunRow = {
  state: string;
  attempt: number;
  items_total: number;
  items_valid: number;
  items_failed: number;
  items_created: number;
  items_unchanged: number;
  items_withdrawn: number;
  error_code: string | null;
  checkpoint: { at?: { page?: number } } | null;
};
const runRow = async (id: string) =>
  (
    await rows<RunRow>(sql`select state, attempt, items_total, items_valid, items_failed, items_created,
      items_unchanged, items_withdrawn, error_code, checkpoint from feed_runs where id = ${id}`)
  )[0] as RunRow;
const resumes = (runId: string) =>
  rows<{ resume: number }>(sql`select (payload->>'resume')::int as resume from outbox_events
    where type = 'imports.run.requested' and payload->>'runId' = ${runId} and payload ? 'resume'
    order by (payload->>'resume')::int`);
const sorted = (n: number[]) => [...n].sort((a, b) => a - b);
const upTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

beforeAll(async () => {
  await setupTestDb('worker');
  imports.configureImports({
    keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }),
    withdrawAfterMissedRuns: 1,
  });
  owner = await createFounder();
  undo = imports.registerConnector({
    ...connector,
    // The taxonomy text gets the run suffix, like the names created below.
    map: (raw, ctx) => {
      const r = connector.map(raw, ctx);
      if (!r.ok) return r;
      const l = r.item.location ?? {};
      return {
        ...r,
        item: {
          ...r.item,
          propertyType: sfx(r.item.propertyType),
          features: [],
          location: {
            ...(l.country ? { country: sfx(l.country) } : {}),
            ...(l.region ? { region: sfx(l.region) } : {}),
            ...(l.city ? { city: sfx(l.city) } : {}),
          },
        },
      };
    },
  });
  await system(async (tx) => {
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `rr-c-${RUN}`,
      translations: tr('Spain'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: `rr-r-${RUN}`,
      translations: tr('Málaga'),
    });
    await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: `rr-m-${RUN}`,
      translations: tr('Marbella'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `rr-types-${RUN}`,
      sort: 0,
      translations: tr('Types'),
    });
    await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `rr-villa-${RUN}`,
      sort: 0,
      translations: tr('Detached Villa'),
    });
  });
}, 120_000);

afterAll(async () => {
  undo?.();
  await closeDb();
});

describe('Resales Online runs in slices (S7-F12)', () => {
  it('[S7-F12] a 15,000-listing account at 40 per page completes across resumes; a re-run withdraws exactly the listings that left', async () => {
    const a = account('1001', 'L', 15_000);
    const connectionId = await connect('1001');
    const first = await as((ctx) => imports.requestFeedRun(ctx, connectionId));
    // 375 pages, 100 per slice: three slices hand the run back, the fourth ends it.
    expect(await runToEnd(first.id, 100)).toEqual(['requeued', 'requeued', 'requeued', 'finished']);
    expect(await runRow(first.id)).toMatchObject({
      state: 'SUCCEEDED',
      attempt: 4,
      items_total: 15_000,
      items_valid: 15_000,
      items_failed: 0,
      items_created: 15_000,
      checkpoint: null,
    });
    expect((await resumes(first.id)).map((r) => r.resume)).toEqual([1, 2, 3]);
    // Every page and every listing's details read exactly once across the slices.
    // …plus each resumed slice's check of the page it resumes after (100, 200, 300).
    expect(sorted(a.pages)).toEqual(sorted([...upTo(375), 100, 200, 300]));
    expect(a.details).toHaveLength(15_000);
    expect(new Set(a.details).size).toBe(15_000);

    // Seven listings leave the feed, one of them on a slice boundary: the next run (again in slices, every other
    // listing unchanged and seen only) withdraws exactly those seven — the earlier slices' sightings counted.
    const gone = ['L000001', 'L004000', 'L004001', 'L007777', 'L012000', 'L014999', 'L015000'];
    for (const r of gone) a.gone.add(r);
    a.pages.length = 0;
    a.details.length = 0;
    const second = await as((ctx) => imports.requestFeedRun(ctx, connectionId));
    expect(await runToEnd(second.id, 100)).toEqual(['requeued', 'requeued', 'requeued', 'finished']);
    expect(await runRow(second.id)).toMatchObject({
      state: 'SUCCEEDED',
      items_total: 14_993,
      items_failed: 0,
      items_created: 0,
      items_withdrawn: 7,
    });
    expect(a.details).toHaveLength(0);
    const withdrawn = await rows<{ ref: string }>(sql`
      select external_ref as ref from property_privates
       where import_connection_id = ${connectionId} and import_withdrawn_at is not null order by external_ref`);
    expect(withdrawn.map((r) => r.ref)).toEqual(gone);
  }, 600_000);

  it('[S7-F12] a timeout mid-run resumes from the last committed page rather than restarting — as a retry, and on the last attempt as a new slice', async () => {
    const a = account('1002', 'T', 1_200);
    const connectionId = await connect('1002');
    const run = await as((ctx) => imports.requestFeedRun(ctx, connectionId));
    // Page 15 times out on every attempt of its call: the job fails retryably after page 13's batch committed
    // (a batch closes on the first page mark at >= 500 listings: 13 pages, 520).
    a.timeouts.set(15, 3);
    const failed = await slice(run.id, { lastAttempt: false });
    expect(failed).toBeInstanceOf(SafeFetchError);
    expect(await runRow(run.id)).toMatchObject({
      state: 'QUEUED',
      items_total: 520,
      checkpoint: expect.objectContaining({ at: expect.objectContaining({ page: 13, position: 520 }) }),
    });
    expect(a.pages).toEqual(upTo(14));

    // The retry resumes at page 14; page 28 times out on the job's last attempt: the progress made since is kept and
    // the run's next slice is queued instead of failing it.
    a.pages.length = 0;
    a.timeouts.set(28, 3);
    expect(await slice(run.id, { lastAttempt: true })).toEqual({ kind: 'requeued' });
    // Page 13 again (the checkpoint's check: unchanged), then 14 onwards.
    expect(a.pages).toEqual(upTo(27).slice(12));
    expect(await runRow(run.id)).toMatchObject({ state: 'QUEUED', items_total: 1_040 });

    a.pages.length = 0;
    expect(await slice(run.id)).toMatchObject({ kind: 'finished', state: 'SUCCEEDED' });
    expect(a.pages).toEqual([26, 27, 28, 29, 30]);
    expect(await runRow(run.id)).toMatchObject({
      state: 'SUCCEEDED',
      attempt: 3,
      items_total: 1_200,
      items_created: 1_200,
      items_failed: 0,
      error_code: null,
    });
    // Only the pages of the batches that never committed (14, 27) were read again: their 80 listings detailed twice,
    // every other listing once, and none stored twice (no DUPLICATE_REF: items_failed 0 above).
    expect(new Set(a.details).size).toBe(1_200);
    expect(a.details).toHaveLength(1_280);
  }, 300_000);

  it('[S7-F12] a run whose connection changed, or whose seen references were lost, between slices starts over', async () => {
    const a = account('1003', 'C', 120);
    const connectionId = await connect('1003');
    const run = await as((ctx) => imports.requestFeedRun(ctx, connectionId));
    expect(await slice(run.id, { sliceMarks: 1 })).toEqual({ kind: 'requeued' });
    expect(await runRow(run.id)).toMatchObject({ items_total: 40 });
    // The feed's address changed (another fingerprint): the next claim starts over from page 1.
    await system((tx) =>
      tx.execute(
        sql`update feed_connections set url = 'https://webapi.resales-online.com/V6/' where id = ${connectionId}`,
      ),
    );
    a.pages.length = 0;
    expect(await slice(run.id, { sliceMarks: 2 })).toEqual({ kind: 'requeued' });
    expect(a.pages).toEqual([1, 2]);
    expect(await runRow(run.id)).toMatchObject({ items_total: 80 });
    // The run's seen references are gone (the UNLOGGED table after a crash): starting over, never resuming blind.
    await system((tx) => tx.execute(sql`delete from property_import_seen where run_id = ${run.id}`));
    a.pages.length = 0;
    expect(await slice(run.id, { sliceMarks: 10 })).toMatchObject({ kind: 'finished', state: 'SUCCEEDED' });
    expect(a.pages).toEqual([1, 2, 3]);
    expect(await runRow(run.id)).toMatchObject({ items_total: 120, items_valid: 120, items_failed: 0 });
  }, 120_000);

  it('[S7-F12] a run refused with "FilterAgencyId not valid" shows that text on the run', async () => {
    const a = account('1004', 'F', 10);
    a.refusal = `FilterAgencyId not valid (p2=${'k'.repeat(40)})`;
    const connectionId = await connect('1004');
    const run = await as((ctx) => imports.requestFeedRun(ctx, connectionId));
    expect(await slice(run.id)).toMatchObject({ kind: 'finished', state: 'FAILED', errorCode: 'FEED_HTTP_STATUS' });
    const dto = await as((ctx) => imports.getFeedRun(ctx, run.id));
    expect(dto).toMatchObject({ state: 'FAILED', errorCode: 'FEED_HTTP_STATUS' });
    expect(dto.errorDetail).toBe('FilterAgencyId not valid (p2=[redacted])');
    // A later run that succeeds carries no detail.
    a.refusal = undefined;
    const next = await as((ctx) => imports.requestFeedRun(ctx, connectionId));
    expect(await slice(next.id)).toMatchObject({ kind: 'finished', state: 'SUCCEEDED' });
    expect((await as((ctx) => imports.getFeedRun(ctx, next.id))).errorDetail).toBeNull();
  }, 120_000);
  it('[S7-F12] a feed that shifted between slices starts the run over and withdraws nothing live; an unchanged one resumes', async () => {
    const a = account('1005', 'D', 120);
    const connectionId = await connect('1005');
    const first = await as((ctx) => imports.requestFeedRun(ctx, connectionId));
    expect(await runToEnd(first.id, 10)).toEqual(['finished']);

    // Unchanged between slices: the check of page 1 passes and the run resumes at page 2.
    const steady = await as((ctx) => imports.requestFeedRun(ctx, connectionId));
    expect(await slice(steady.id, { sliceMarks: 1 })).toEqual({ kind: 'requeued' });
    a.pages.length = 0;
    expect(await slice(steady.id, { sliceMarks: 10 })).toMatchObject({ kind: 'finished', state: 'SUCCEEDED' });
    expect(a.pages).toEqual([1, 2, 3]);
    expect(await runRow(steady.id)).toMatchObject({ items_total: 120, items_withdrawn: 0 });

    // D000010 leaves after page 1 committed: every later listing moves up one place, so page 2 would start at D000042
    // and D000041 would never be seen (and be withdrawn). The check of page 1 finds another last listing: start over.
    const shifted = await as((ctx) => imports.requestFeedRun(ctx, connectionId));
    expect(await slice(shifted.id, { sliceMarks: 1 })).toEqual({ kind: 'requeued' });
    a.gone.add('D000010');
    a.pages.length = 0;
    expect(await slice(shifted.id, { sliceMarks: 10 })).toMatchObject({ kind: 'finished', state: 'SUCCEEDED' });
    expect(a.pages).toEqual([1, 1, 2, 3]);
    expect(await runRow(shifted.id)).toMatchObject({ items_total: 119, items_failed: 0, items_withdrawn: 1 });
    const withdrawn = await rows<{ ref: string }>(sql`
      select external_ref as ref from property_privates
       where import_connection_id = ${connectionId} and import_withdrawn_at is not null`);
    expect(withdrawn.map((r) => r.ref)).toEqual(['D000010']);
  }, 120_000);

  const seenCount = async (runId: string) =>
    (await rows<{ n: number }>(sql`select count(*)::int as n from property_import_seen where run_id = ${runId}`))[0]?.n;
  const jobCtx = () => ({
    log,
    jobId: newId(),
    attempt: 1,
    progress: async () => {},
    signal: new AbortController().signal,
  });

  it('[S7-F12] a queued next slice created long ago but handed back just now is not failed as never started', async () => {
    account('1006', 'Q', 80);
    const connectionId = await connect('1006');
    const run = await as((ctx) => imports.requestFeedRun(ctx, connectionId));
    expect(await slice(run.id, { sliceMarks: 1 })).toEqual({ kind: 'requeued' });
    await system((tx) =>
      tx.execute(
        sql`update feed_runs set created_at = now() - interval '3 days', updated_at = now() where id = ${run.id}`,
      ),
    );
    await imports.importsJobs.scheduleFeeds.spec.run({}, jobCtx());
    expect(await runRow(run.id)).toMatchObject({ state: 'QUEUED', error_code: null });
    // Handed back a day ago and never picked up: that one is stale.
    await system((tx) =>
      tx.execute(sql`update feed_runs set updated_at = now() - interval '25 hours' where id = ${run.id}`),
    );
    await imports.importsJobs.scheduleFeeds.spec.run({}, jobCtx());
    expect(await runRow(run.id)).toMatchObject({ state: 'FAILED', error_code: 'FEED_NEVER_STARTED' });
    // The shared database's staff health window would read this backdated run as a 3-day queue wait.
    await system((tx) => tx.execute(sql`update feed_runs set created_at = started_at where id = ${run.id}`));
  }, 120_000);

  it('[S7-F12] the claim after attempt 100, or a day after the run started, ends it FEED_TIMEOUT and drops its seen references', async () => {
    account('1007', 'M', 80);
    const connectionId = await connect('1007');
    const many = await as((ctx) => imports.requestFeedRun(ctx, connectionId));
    expect(await slice(many.id, { sliceMarks: 1 })).toEqual({ kind: 'requeued' });
    expect(await seenCount(many.id)).toBe(40);
    await system((tx) => tx.execute(sql`update feed_runs set attempt = ${RUNS.MAX_CLAIMS} where id = ${many.id}`));
    expect(await slice(many.id)).toMatchObject({ kind: 'finished', state: 'FAILED', errorCode: 'FEED_TIMEOUT' });
    expect(await runRow(many.id)).toMatchObject({ attempt: RUNS.MAX_CLAIMS + 1 });
    expect(await seenCount(many.id)).toBe(0);

    const long = await as((ctx) => imports.requestFeedRun(ctx, connectionId));
    expect(await slice(long.id, { sliceMarks: 1 })).toEqual({ kind: 'requeued' });
    await system((tx) =>
      tx.execute(sql`update feed_runs set started_at = now() - interval '25 hours' where id = ${long.id}`),
    );
    expect(await slice(long.id)).toMatchObject({ kind: 'finished', state: 'FAILED', errorCode: 'FEED_TIMEOUT' });
    expect(await seenCount(long.id)).toBe(0);
  }, 120_000);

  it('[S7-F12] the daily prune keeps the seen references of a run still in progress, however old', async () => {
    account('1008', 'P', 80);
    const connectionId = await connect('1008');
    const run = await as((ctx) => imports.requestFeedRun(ctx, connectionId));
    expect(await slice(run.id, { sliceMarks: 1 })).toEqual({ kind: 'requeued' });
    const dead = newId();
    await system(async (tx) => {
      await tx.execute(
        sql`update property_import_seen set created_at = now() - interval '2 days' where run_id = ${run.id}`,
      );
      await tx.execute(sql`insert into property_import_seen (agency_id, run_id, external_ref, created_at)
        values (${owner.agencyId}, ${dead}, 'X1', now() - interval '2 days')`);
    });
    await imports.importsJobs.pruneRuns.spec.run({}, jobCtx());
    expect(await seenCount(run.id)).toBe(40);
    expect(await seenCount(dead)).toBe(0);
    // …and the run still resumes and ends correctly.
    expect(await slice(run.id, { sliceMarks: 10 })).toMatchObject({ kind: 'finished', state: 'SUCCEEDED' });
    expect(await runRow(run.id)).toMatchObject({ items_total: 80, items_failed: 0 });
  }, 300_000);
});
