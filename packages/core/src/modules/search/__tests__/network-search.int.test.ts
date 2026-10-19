import {
  CreateDevelopmentBody,
  CreateListingBody,
  CreateUnitsBody,
  NetworkSearchBody,
  type NetworkSearchResult,
  SetDevelopmentAccessBody,
  SetGiveToGetExemptionBody,
  UpdateListingBody,
} from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { createStaffUser, loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { configureSearch, createMeiliEngine, type SearchEngine } from '@inmolink/platform/search';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx, CtxRunner } from '../../../context';
import { withMemberCtx } from '../../../member';
import { withStaffCtx } from '../../../staff';
import { createFounder, type Founder } from '../../../testing/factories';
import * as agencies from '../../agencies';
import * as developments from '../../developments';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import * as search from '../index';
import { networkFilter } from '../network';
import * as repo from '../repo';

/**
 * Network search (S5-05) on the real test database and Meilisearch: who sees which listings and units, the
 * give-to-get gate, the commission terms of each result, and the request's statements.
 */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const UID = `t_network_${RUN.replace(/[^A-Za-z0-9]/g, '')}`;
const real = () =>
  createMeiliEngine({ url: process.env.MEILI_URL as string, apiKey: process.env.MEILI_MASTER_KEY as string });

/** v: the viewer · a: shares with ALL and PREFERRED (does not prefer v) · b: prefers v · d: a developer. */
let v: Founder;
let a: Founder;
let b: Founder;
let d: Founder;
let ids: { country: string; villa: string; flat: string };
const L: Record<string, string> = {};
const U: Record<string, string> = {};
const DEV: Record<string, string> = {};
/** A staff reason for the give-to-get exemption (S6-F1). */
const REASON = 'Ticket 4711: buyer-only agency, confirmed by phone';

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const runner =
  (m: Founder): CtxRunner =>
  (fn) =>
    as(m, fn);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('search.network.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const net = (m: Founder, body: NetworkSearchBody = {}, engine?: SearchEngine) =>
  search.searchNetwork(runner(m), { limit: 50, ...body }, engine ? { engine } : {});
const ok = (r: NetworkSearchResult) => {
  if (r.status !== 'OK') throw new Error(`expected results, got ${r.status}`);
  return r;
};
const idsOf = (r: NetworkSearchResult) => ok(r).items.map((i) => i.id);

async function listing(
  m: Founder,
  body: Partial<CreateListingBody>,
  state: Pick<UpdateListingBody, 'visibility' | 'shareScope'> & { status?: 'ACTIVE' | 'DRAFT' },
): Promise<string> {
  const { id } = await as(m, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.country,
        priceCents: 50_000_000,
        energyRating: 'B',
        commission: { type: 'PCT', basisPoints: 500, includesVat: false },
        splitBp: 5000,
        ...body,
      }),
    ),
  );
  await as(m, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({
        status: state.status ?? 'ACTIVE',
        visibility: state.visibility,
        shareScope: state.shareScope,
        version: (await properties.getListing(ctx, id)).version,
      }),
    ),
  );
  return id;
}

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  [v, a, b, d] = await Promise.all([createFounder(), createFounder(), createFounder(), createFounder()]);
  for (const m of [v, a, b, d]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: code(n.toLowerCase()) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('ns'),
      translations: name('Netland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('ns-g'),
      sort: 0,
      translations: name('Homes'),
    });
    const type = (t: string) =>
      taxonomy.createPropertyType(tx, { groupId: group, key: code(`ns-${t}`), sort: 0, translations: name(t) });
    return { country, villa: await type('Villa'), flat: await type('Flat') };
  });
  // b prefers v (its PREFERRED listings reach v); v prefers b (the "preferred only" filter).
  await as(b, (ctx) => agencies.addPreferredAgency(ctx, { agencyId: v.agencyId }));
  await as(v, (ctx) => agencies.addPreferredAgency(ctx, { agencyId: b.agencyId }));

  L.aAll = await listing(a, { priceCents: 50_000_000 }, { visibility: 'SHARED', shareScope: 'ALL' });
  L.aPublic = await listing(
    a,
    {
      priceCents: 70_000_000,
      commission: { type: 'FIXED', amount: { amountCents: 2_000_000, currency: 'EUR' }, includesVat: true },
      splitBp: 4000,
    },
    { visibility: 'PUBLIC', shareScope: 'ALL' },
  );
  L.aPreferred = await listing(a, {}, { visibility: 'SHARED', shareScope: 'PREFERRED' });
  L.aPrivate = await listing(a, {}, { visibility: 'PRIVATE' });
  L.bPreferred = await listing(
    b,
    {
      propertyTypeId: ids.flat,
      priceCents: 30_000_000,
      commission: { type: 'PCT', basisPoints: 300, includesVat: false },
      splitBp: 6000,
    },
    { visibility: 'SHARED', shareScope: 'PREFERRED' },
  );
  L.vOwn = await listing(v, {}, { visibility: 'SHARED', shareScope: 'ALL' });

  // Developer d: one development shared with v, one shared with nobody (both PRIVATE_NETWORK).
  for (const [key, allowed] of [
    ['shared', [v.agencyId]],
    ['closed', [a.agencyId]],
  ] as const) {
    const dev = await as(d, (ctx) =>
      developments.createDevelopment(
        ctx,
        CreateDevelopmentBody.parse({
          ref: code(`ND-${key}`),
          name: `Heights ${key}`,
          locationId: ids.country,
          commission: { type: 'PCT', basisPoints: 400, includesVat: false },
        }),
      ),
    );
    DEV[key] = dev.id;
    await as(d, (ctx) =>
      developments.setDevelopmentAccess(
        ctx,
        dev.id,
        SetDevelopmentAccessBody.parse({ version: dev.version, kind: 'PRIVATE_NETWORK', allowedAgencyIds: allowed }),
      ),
    );
    const [unit] = (
      await as(d, (ctx) =>
        developments.createUnits(
          ctx,
          dev.id,
          CreateUnitsBody.parse({
            units: [{ ref: `U-${key}`, propertyTypeId: ids.flat, bedrooms: 2, priceCents: 25_000_000 }],
          }),
        ),
      )
    ).items;
    U[key] = unit?.id as string;
  }

  await system(async (tx) => {
    await search.rebuildReadModels(tx, 'LISTING', Object.values(L));
    await search.rebuildReadModels(tx, 'UNIT', Object.values(U));
  });
  configureSearch(real());
  search.configureSearchIndex({ uid: UID, scope: [...Object.values(L), ...Object.values(U)] });
  await search.ensureListingsIndex(real(), search.listingsIndex(UID));
  await search.syncIndex();
  // v shares one listing: open through the threshold here; the gate's own tests change it.
  search.configureNetworkSearch({ giveToGetMinShared: 1 });
}, 180_000);

afterAll(async () => {
  search.configureNetworkSearch({});
  await real().dropIndex(UID);
  const owners = [v, a, b, d].filter(Boolean).map((m) => m.agencyId);
  if (owners.length === 0) return closeDb();
  const targets = [...Object.values(L), ...Object.values(U)];
  await system(async (tx) => {
    const list = (xs: string[]) =>
      sql.join(
        xs.map((x) => sql`${x}`),
        sql`, `,
      );
    if (targets.length) {
      await tx.execute(sql`delete from search_index_queue where target_id in (${list(targets)})`);
      await tx.execute(sql`delete from listing_search_docs where target_id in (${list(targets)})`);
    }
    await tx.execute(sql`delete from read_model_queue where owner_agency_id in (${list(owners)})`);
    await tx.execute(sql`delete from listing_read_models where agency_id in (${list(owners)})`);
  });
  await closeDb();
});

describe('who sees what', () => {
  it('[S5-05] results never include PRIVATE listings or PREFERRED listings from non-preferring owners', async () => {
    const found = idsOf(await net(v));
    // The index holds PREFERRED listings of a (it does not prefer v), a's PRIVATE one has no document at all.
    expect(found.sort()).toEqual([L.aAll, L.aPublic, L.bPreferred, U.shared].sort());
    expect(found).not.toContain(L.aPrivate);
    expect(found).not.toContain(L.aPreferred);
    // Never the caller's own; never a unit of a development not shared with it.
    expect(found).not.toContain(L.vOwn);
    expect(found).not.toContain(U.closed);
    // v reads the shared unit's card, never who else the developer shares it with (column grant, security review).
    await expect(
      as(v, (ctx) =>
        ctx.tx.execute(sql`select allowed_agency_ids from listing_read_models where target_id = ${U.shared}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    // a sees its partner's view, not v's: b does not prefer a.
    expect(idsOf(await net(a))).not.toContain(L.bPreferred);
  });

  it('[S5-05] a document the index still holds is left out when RLS no longer lets the caller read it', async () => {
    // b stops preferring v: until the next index push the document still matches, but the page drops it.
    await as(b, (ctx) => agencies.removePreferredAgency(ctx, { agencyId: v.agencyId }));
    try {
      const engineIds = [L.bPreferred as string, L.aAll as string];
      const stale = {
        ...real(),
        search: async () => ({ ids: engineIds, total: 2, facets: {}, facetStats: {}, tookMs: 1 }),
      };
      expect(idsOf(await net(v, {}, stale as SearchEngine))).toEqual([L.aAll]);
    } finally {
      await as(b, (ctx) => agencies.addPreferredAgency(ctx, { agencyId: v.agencyId }));
    }
  });

  it('[S5-05] filters: preferred agencies only, new-builds, kind and type', async () => {
    expect(idsOf(await net(v, { preferredOnly: true }))).toEqual([L.bPreferred]);
    expect(idsOf(await net(v, { newBuilds: true }))).toEqual([U.shared]);
    expect(idsOf(await net(v, { kind: 'LISTING', propertyTypeIds: [ids.flat] }))).toEqual([L.bPreferred]);
    const page = ok(await net(v, { kind: 'LISTING', sort: 'price_asc', limit: 2 }));
    expect(page.items.map((i) => i.id)).toEqual([L.bPreferred, L.aAll]);
    expect(page.nextCursor).not.toBeNull();
    expect(
      idsOf(await net(v, { kind: 'LISTING', sort: 'price_asc', limit: 2, cursor: page.nextCursor as string })),
    ).toEqual([L.aPublic]);
  });

  it('[S5-05] Client Mode and unverified agencies are refused', async () => {
    const client: CtxRunner = (fn) => as(v, (ctx) => fn({ ...ctx, clientMode: true }));
    await expect(search.searchNetwork(client, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const pending = await createFounder();
    await expect(net(pending)).rejects.toMatchObject({ code: 'VERIFICATION_REQUIRED' });
  });
});

describe('index-side access (S6-F2)', () => {
  /** Rebuilds these listings' read models and pushes their documents (what the queue and the sync do). */
  const refresh = async (...listingIds: string[]) => {
    await system((tx) => search.rebuildReadModels(tx, 'LISTING', listingIds));
    await search.syncIndex();
  };

  it('[S6-F2] a freshness-hidden listing is not counted in a network search total', async () => {
    const before = ok(await net(v));
    expect(before.items.map((i) => i.id)).toContain(L.aPublic);
    expect(before.total).toBe(before.items.length);
    // a's PUBLIC listing goes unconfirmed past 120 days: hidden from the network (S3-08), still on a's own channels.
    await rows(sql`update properties set network_hidden_at = now() where id = ${L.aPublic}`);
    try {
      await refresh(L.aPublic as string);
      const [rm] = await rows<{ public: boolean; network_hidden: boolean }>(
        sql`select public, network_hidden from listing_read_models where target_id = ${L.aPublic} limit 1`,
      );
      expect(rm).toEqual({ public: true, network_hidden: true });
      expect(await real().fetch(UID, [L.aPublic as string], ['networkHidden'])).toEqual([{ networkHidden: true }]);

      const after = ok(await net(v));
      expect(after.items.map((i) => i.id)).not.toContain(L.aPublic);
      // The engine leaves it out: the total counts only what the caller can page to, and the page is full.
      expect(after.total).toBe(before.total - 1);
      expect(after.total).toBe(after.items.length);
      // A page of one is still a full page: the next cursor reaches everything the total counts.
      const one = ok(await net(v, { limit: 1 }));
      expect(one.items).toHaveLength(1);
      // The flag is index-only: a member cannot read it (column grant), like the share scope.
      await expect(
        as(v, (ctx) => ctx.tx.execute(sql`select network_hidden from listing_read_models where target_id = ${L.aAll}`)),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
    } finally {
      await rows(sql`update properties set network_hidden_at = null where id = ${L.aPublic}`);
      await refresh(L.aPublic as string);
    }
    expect(idsOf(await net(v))).toContain(L.aPublic);
  });

  it('[S6-F2] a network search by an agency preferred by 2,001 owners still shows their PREFERRED listings', async () => {
    const tag = `Filler S6-F2 ${RUN}`;
    // 2,000 more verified owners prefer v (b is the 2,001st) — past the old 2,000-owner filter cap.
    await rows(sql`
      with filler as (
        insert into agencies (agency_id, kind, status, name)
        select gen_random_uuid(), 'AGENCY', 'VERIFIED', ${tag} || ' ' || g from generate_series(1, 2000) g
        returning agency_id)
      insert into preferred_agencies (agency_id, preferred_agency_id)
      select agency_id, ${v.agencyId}::uuid from filler`);
    try {
      const [{ n } = { n: 0 }] = await rows<{ n: number }>(
        sql`select count(*)::int as n from preferred_agencies where preferred_agency_id = ${v.agencyId}`,
      );
      expect(n).toBe(2_001);
      const result = ok(await net(v));
      expect(result.items.map((i) => i.id)).toContain(L.bPreferred);
      expect(ok(await net(v, { preferredOnly: true })).items.map((i) => i.id)).toEqual([L.bPreferred]);
      // b's document names the agencies b prefers; the filter names only the caller (no owner list per query).
      expect(await real().fetch(UID, [L.bPreferred as string], ['preferredAgencyIds'])).toEqual([
        { preferredAgencyIds: [v.agencyId] },
      ]);
      const filter = networkFilter({ self: v.agencyId, preferred: [] }, NetworkSearchBody.parse({}));
      expect(JSON.stringify(filter)).not.toContain('"ownerAgencyId","values"');
      // b changing its list re-queues only its PREFERRED listings (their documents carry the list).
      expect(await search.queueAgencyReadModelChanges(b.agencyId, 60_000, { preferredOnly: true })).toBe(1);
      expect(await search.queueAgencyReadModelChanges(a.agencyId, 60_000, { preferredOnly: true })).toBe(1);
    } finally {
      await rows(sql`delete from read_model_queue where owner_agency_id in (${a.agencyId}, ${b.agencyId})`);
      await rows(sql`
        with gone as (delete from preferred_agencies p using agencies g
          where g.agency_id = p.agency_id and g.name like ${`${tag} %`} returning p.agency_id)
        delete from agencies where name like ${`${tag} %`}`);
    }
  });
});

describe('commission', () => {
  it("[S5-05] each result shows the total %, the split and the viewer's own earnings from the listing's values", async () => {
    const items = new Map(ok(await net(v)).items.map((i) => [i.id, i]));
    // €500,000 × 5 % × 50 % = €12,500
    expect(items.get(L.aAll as string)).toMatchObject({
      kind: 'LISTING',
      ownerAgency: { id: a.agencyId },
      preferred: false,
      commission: {
        type: 'PCT',
        totalBp: 500,
        splitBp: 5000,
        viewerEarnings: { amountCents: 1_250_000, currency: 'EUR' },
      },
    });
    // fixed €20,000 × 40 % = €8,000
    expect(items.get(L.aPublic as string)?.commission).toEqual({
      type: 'FIXED',
      totalBp: null,
      fixed: { amountCents: 2_000_000, currency: 'EUR' },
      splitBp: 4000,
      includesVat: true,
      viewerEarnings: { amountCents: 800_000, currency: 'EUR' },
    });
    // €300,000 × 3 % × 60 % = €5,400; b is on v's preferred list
    expect(items.get(L.bPreferred as string)).toMatchObject({
      preferred: true,
      commission: { totalBp: 300, splitBp: 6000, viewerEarnings: { amountCents: 540_000 } },
    });
    // A unit: the development's 4 %, paid whole by the developer — €250,000 × 4 % = €10,000
    expect(items.get(U.shared as string)).toMatchObject({
      kind: 'UNIT',
      ownerAgency: { id: d.agencyId },
      commission: { type: 'PCT', totalBp: 400, splitBp: 10_000, viewerEarnings: { amountCents: 1_000_000 } },
    });
    // Agent side: the owner's name; the card is the client-safe read model.
    const name = await rows<{ name: string }>(sql`select name from agency_directory where agency_id = ${a.agencyId}`);
    expect(items.get(L.aAll as string)?.ownerAgency.name).toBe(name[0]?.name);
    expect(items.get(L.aAll as string)?.card).not.toHaveProperty('commission');
  });

  it('[S5-05] a page is at most ten statements (dashboard budget)', async () => {
    expect(await countQueries(() => net(v))).toBeLessThanOrEqual(10);
  });

  it("[S6-F3] hydration reads the viewer's locale and the fallback first, another locale only for ids still missing", async () => {
    const ids = [L.aAll as string, L.bPreferred as string];
    const reads = { match: /listing_read_models/ };
    const cards = (locale: string, fallback: string) =>
      as(v, (ctx) => repo.networkCards(ctx.tx, ids, locale, fallback));
    let found: Awaited<ReturnType<typeof cards>> = [];
    // Both have the viewer's locale.
    expect(
      await countQueries(async () => {
        found = await cards('en', 'es');
      }, reads),
    ).toBe(1);
    expect(found.map((c) => c.targetId).sort()).toEqual([...ids].sort());
    // Neither the viewer's locale nor the fallback exists: the same statement reads one card of another locale each.
    expect(
      await countQueries(async () => {
        found = await cards('xx', 'yy');
      }, reads),
    ).toBe(1);
    expect(found.map((c) => c.targetId).sort()).toEqual([...ids].sort());
    // The plan: primary-key probes for the two locales, then one row per target still missing (no sort of every card).
    const plan = await as(v, async (ctx) =>
      (
        await ctx.tx.execute(sql`explain select 1 from listing_read_models m
          where m.target_id = ${ids[0]}::uuid order by m.locale limit 1`)
      ).rows
        .map((r) => Object.values(r)[0])
        .join(' '),
    );
    expect(plan).toContain('listing_read_models_pk');
  });
});

describe('give-to-get', () => {
  it('[S5-05] agency below the give-to-get threshold after grace sees a clear upsell state, not results', async () => {
    search.configureNetworkSearch({ giveToGetMinShared: 5 });
    try {
      // New: within the 30-day grace period it searches, and is told how far it is.
      const grace = ok(await net(v));
      expect(grace.gate).toMatchObject({ state: 'GRACE', sharedListings: 1, threshold: 5 });
      expect(grace.items.length).toBeGreaterThan(0);

      // Past grace with one shared listing of five: the upsell, no results at all.
      await rows(sql`update agencies set created_at = now() - interval '31 days' where agency_id = ${v.agencyId}`);
      const locked = await net(v);
      expect(locked).toEqual({
        status: 'LOCKED',
        gate: expect.objectContaining({ state: 'LOCKED', sharedListings: 1, threshold: 5 }),
      });
      expect(locked).not.toHaveProperty('items');

      // Staff exempt a buyer-only agency (audited); the agency itself cannot.
      const staff = await createStaffUser('STAFF_SUPPORT');
      const asStaff = <T>(fn: Parameters<typeof withStaffCtx<T>>[1]) =>
        withStaffCtx({ userId: staff.userId, requestId: newId(), reason: 'network test' }, fn);
      const detail = await asStaff((ctx) =>
        agencies.setGiveToGetExemption(ctx, { agencyId: v.agencyId, exempt: true, reason: REASON }),
      );
      expect(detail.giveToGetExempt).toBe(true);
      expect(ok(await net(v)).gate.state).toBe('EXEMPT');
      await expect(
        as(v, (ctx) =>
          ctx.tx.execute(sql`update agencies set give_to_get_exempt = false where agency_id = ${v.agencyId}`),
        ),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
      const audit = await rows<{ metadata: { after: boolean } }>(
        sql`select metadata from audit_logs where agency_id = ${v.agencyId} and type = 'agencies.giveToGet.changed'`,
      );
      expect(audit.map((r) => r.metadata.after)).toEqual([true]);

      // Exemption ended, five shared listings: open on the threshold.
      await asStaff((ctx) =>
        agencies.setGiveToGetExemption(ctx, { agencyId: v.agencyId, exempt: false, reason: REASON }),
      );
      search.configureNetworkSearch({ giveToGetMinShared: 1 });
      expect(ok(await net(v)).gate.state).toBe('OPEN');
    } finally {
      search.configureNetworkSearch({ giveToGetMinShared: 1 });
      await rows(sql`update agencies set created_at = now() where agency_id = ${v.agencyId}`);
    }
  });

  it('[S6-F1] the give-to-get exemption takes a staff reason and audits the exemption before and after', async () => {
    const m = await createFounder();
    const staff = await createStaffUser('STAFF_SUPPORT');
    const asStaff = <T>(fn: Parameters<typeof withStaffCtx<T>>[1]) =>
      withStaffCtx({ userId: staff.userId, requestId: newId(), reason: 'network test' }, fn);
    const set = (exempt: boolean, reason: string) =>
      asStaff((ctx) => agencies.setGiveToGetExemption(ctx, { agencyId: m.agencyId, exempt, reason }));

    // The body needs a reason of 10–500 characters (no markup).
    for (const reason of [undefined, 'too short', '<b>ticket 4711: buyer-only</b>', 'x'.repeat(501)]) {
      expect(SetGiveToGetExemptionBody.safeParse({ exempt: true, reason }).success, String(reason)).toBe(false);
    }
    expect(
      SetGiveToGetExemptionBody.parse({
        exempt: true,
        reason: `  ${REASON}
`,
      }).reason,
    ).toBe(REASON);

    expect((await set(true, REASON)).giveToGetReason).toBe(REASON);
    // The same value again is still a staff decision: audited, with its own reason.
    const again = await set(true, 'Ticket 4712: confirmed again by phone');
    expect(again).toMatchObject({ giveToGetExempt: true, giveToGetReason: 'Ticket 4712: confirmed again by phone' });
    await set(false, 'Ticket 4713: the agency now lists homes');

    const audit = await rows<{ metadata: Record<string, unknown>; actor_kind: string }>(
      sql`select metadata, actor_kind from audit_logs
           where agency_id = ${m.agencyId} and type = 'agencies.giveToGet.changed' order by occurred_at, id`,
    );
    expect(audit.map((r) => r.metadata)).toEqual([
      { before: false, after: true },
      { before: true, after: true },
      { before: true, after: false },
    ]);
    expect(new Set(audit.map((r) => r.actor_kind))).toEqual(new Set(['staff']));
    // Free text stays out of the audit log; the agency cannot write the reason itself.
    expect(JSON.stringify(audit)).not.toContain('Ticket');
    await expect(
      as(m, (ctx) =>
        ctx.tx.execute(sql`update agencies set give_to_get_reason = 'self-granted' where agency_id = ${m.agencyId}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
