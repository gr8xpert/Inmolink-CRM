import {
  CreateDevelopmentBody,
  CreateUnitsBody,
  type NetworkSearchResult,
  SetDevelopmentAccessBody,
} from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb, withAdminRollback } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx, CtxRunner } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as developments from '../index';

/**
 * R2-07a developer portal on the real database and Meilisearch: a developer uploads a development's units from a
 * Kyero file, restricts it to three agencies, and only those three find it — in network search (the index filter and
 * the read model's RLS), in the development and in its unit table. Scoped to this file's own agencies and ids.
 */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const UID = `t_devportal_${RUN.replace(/[^A-Za-z0-9]/g, '')}`;
const real = () =>
  createMeiliEngine({ url: process.env.MEILI_URL as string, apiKey: process.env.MEILI_MASTER_KEY as string });

/** d: the developer · x, y, z: the three agencies it names · w: a verified agency it does not name. */
let d: Founder;
let x: Founder;
let y: Founder;
let z: Founder;
let w: Founder;
let ids: { country: string; villa: string; flat: string };
let devId = '';
let unitIds: string[] = [];

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const runner =
  (m: Founder): CtxRunner =>
  (fn) =>
    as(m, fn);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('developments.portal.test', fn);
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (err: { code?: string }) => err.code ?? String(err),
  );
const xml = (s: string) => new TextEncoder().encode(s);
const property = (id: string, type: string, extra = '') =>
  `<property><id>${id}</id><type>${type}</type><price>${250_000}</price><beds>2</beds><baths>2</baths>` +
  `<surface_area><built>95</built><plot>0</plot></surface_area>${extra}</property>`;
const kyeroFile = (props: string[]) =>
  xml(
    `<?xml version="1.0" encoding="UTF-8"?>\n<root><kyero><feed_version>3</feed_version></kyero>${props.join('')}</root>`,
  );

const ok = (r: NetworkSearchResult) => {
  if (r.status !== 'OK') throw new Error(`expected results, got ${r.status}`);
  return r;
};
const found = async (m: Founder) =>
  ok(await search.searchNetwork(runner(m), { limit: 50, newBuilds: true }))
    .items.map((i) => i.id)
    .filter((id) => unitIds.includes(id))
    .sort();

/** The read models and the index after a change (the worker's outbox steps, run here in order). */
async function republish(): Promise<void> {
  await system((tx) => search.rebuildReadModels(tx, 'UNIT', unitIds));
  await search.syncIndex();
}

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  [d, x, y, z, w] = await Promise.all([
    createFounder({ accountKind: 'DEVELOPER', companyName: `Promotora ${RUN} S.L.` }),
    createFounder({ companyName: `Xanadu ${RUN} S.L.` }),
    createFounder({ companyName: `Yucca ${RUN} S.L.` }),
    createFounder({ companyName: `Zenit ${RUN} S.L.` }),
    createFounder({ companyName: `Westside ${RUN} S.L.` }),
  ]);
  for (const m of [d, x, y, z, w]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: code(n.toLowerCase()) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('dp'),
      translations: name('Devland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('dp-g'),
      sort: 0,
      translations: name('Homes'),
    });
    const type = (t: string) =>
      taxonomy.createPropertyType(tx, { groupId: group, key: code(`dp-${t}`), sort: 0, translations: name(t) });
    return { country, villa: await type('Villa'), flat: await type('Flat') };
  });
  const dev = await as(d, (ctx) =>
    developments.createDevelopment(
      ctx,
      CreateDevelopmentBody.parse({
        ref: code('DP'),
        name: `Mirador ${RUN}`,
        locationId: ids.country,
        commission: { type: 'PCT', basisPoints: 400, includesVat: false },
      }),
    ),
  );
  devId = dev.id;
  configureSearch(real());
}, 180_000);

afterAll(async () => {
  search.configureNetworkSearch({});
  await real()
    .dropIndex(UID)
    .catch(() => undefined);
  const owners = [d, x, y, z, w].filter(Boolean).map((m) => m.agencyId);
  if (owners.length > 0) {
    await system(async (tx) => {
      const list = (xs: string[]) =>
        sql.join(
          xs.map((v) => sql`${v}`),
          sql`, `,
        );
      if (unitIds.length) {
        await tx.execute(sql`delete from search_index_queue where target_id in (${list(unitIds)})`);
        await tx.execute(sql`delete from listing_search_docs where target_id in (${list(unitIds)})`);
      }
      await tx.execute(sql`delete from read_model_queue where owner_agency_id in (${list(owners)})`);
      await tx.execute(sql`delete from listing_read_models where agency_id in (${list(owners)})`);
    });
  }
  await closeDb();
});

describe('bulk upload from a Kyero file', () => {
  it('[R2-07] a Kyero file reads as units: types by name, nothing stored until createUnits', async () => {
    const file = kyeroFile([
      property('K-01', `Villa ${RUN}`),
      property('K-02', `flat ${RUN}`), // names match case-insensitively
      property('K-03', `Villa ${RUN}`, '<currency>EUR</currency>'),
    ]);
    const preview = await developments.readKyeroUnits(runner(d), devId, file);
    expect(preview.problems).toEqual([]);
    expect(preview.units).toEqual([
      expect.objectContaining({ ref: 'K-01', propertyTypeId: ids.villa, priceCents: 25_000_000, bedrooms: 2 }),
      expect.objectContaining({ ref: 'K-02', propertyTypeId: ids.flat, internalM2: 95, plotM2: null }),
      expect.objectContaining({ ref: 'K-03', propertyTypeId: ids.villa }),
    ]);
    // Two short transactions (each with its member check): the development, then the type names; budget ≤ 10.
    expect(await countQueries(() => developments.readKyeroUnits(runner(d), devId, file))).toBeLessThanOrEqual(10);
    // Read only: the development still has no units.
    expect((await as(d, (ctx) => developments.listUnits(ctx, devId, { limit: 100 }))).items).toEqual([]);

    const created = await as(d, (ctx) =>
      developments.createUnits(ctx, devId, CreateUnitsBody.parse({ units: preview.units })),
    );
    unitIds = created.items.map((u) => u.id);
    expect(created.items.map((u) => [u.ref, u.status])).toEqual([
      ['K-01', 'AVAILABLE'],
      ['K-02', 'AVAILABLE'],
      ['K-03', 'AVAILABLE'],
    ]);
  });

  it('[R2-07] each problem names the property: rental, unknown type, duplicate id, other currency, missing id', async () => {
    const preview = await developments.readKyeroUnits(
      runner(d),
      devId,
      kyeroFile([
        property('P-1', `Villa ${RUN}`, '<price_freq>month</price_freq>'),
        property('P-2', `Qwzx Nonexistent ${RUN}`),
        property('P-3', `Villa ${RUN}`),
        property('P-3', `Villa ${RUN}`),
        property('P-5', `Villa ${RUN}`, '<currency>GBP</currency>'),
        '<property><type>Villa</type></property>',
        property('P-1', `Villa ${RUN}`), // repeats an id whose first copy has a problem of its own
      ]),
    );
    expect(preview.units).toEqual([]); // all or nothing, as the CSV import
    expect(preview.problems.map((p) => [p.position, p.field, p.reason])).toEqual([
      [1, 'price_freq', 'notSale'],
      [2, 'type', 'unknownType'],
      [4, 'id', 'duplicate'],
      [5, 'currency', 'currency'],
      [6, 'id', 'required'],
      [7, 'id', 'duplicate'],
    ]);
  });

  it('[R2-07] refuses what is not a readable Kyero file, and any caller but the owner', async () => {
    const one = kyeroFile([property('R-1', `Villa ${RUN}`)]);
    expect(await refusal(developments.readKyeroUnits(runner(d), devId, xml('%PDF-1.7 not xml')))).toBe(
      'KYERO_FILE_INVALID',
    );
    // XXE / billion laughs: the parser refuses any DOCTYPE.
    const xxe = xml(
      '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY e SYSTEM "file:///etc/passwd">]><root><property><id>&e;</id></property></root>',
    );
    expect(await refusal(developments.readKyeroUnits(runner(d), devId, xxe))).toBe('KYERO_FILE_INVALID');
    expect(await refusal(developments.readKyeroUnits(runner(d), devId, xml('<root><other/></root>')))).toBe(
      'KYERO_FILE_INVALID',
    );
    expect(await refusal(developments.readKyeroUnits(runner(d), devId, new Uint8Array(5 * 1024 * 1024 + 1)))).toBe(
      'PAYLOAD_TOO_LARGE',
    );
    // Another agency cannot even see the development yet (not shared): not found, as for an unknown id.
    expect(await refusal(developments.readKyeroUnits(runner(x), devId, one))).toBe('DEVELOPMENT_NOT_FOUND');
    expect(await refusal(developments.readKyeroUnits(runner(d), newId(), one))).toBe('DEVELOPMENT_NOT_FOUND');
  });
});

describe('restricted to three agencies', () => {
  it('[R2-07] a development restricted to 3 agencies is found by exactly those 3, never by a 4th', async () => {
    expect(unitIds).toHaveLength(3);
    const dev = await as(d, (ctx) => developments.getDevelopment(ctx, devId));
    // x, y, z are not the developer's preferred agencies: any agency in the directory may be named.
    const shared = await as(d, (ctx) =>
      developments.setDevelopmentAccess(
        ctx,
        devId,
        SetDevelopmentAccessBody.parse({
          version: dev.version,
          kind: 'PRIVATE_NETWORK',
          allowedAgencyIds: [x.agencyId, y.agencyId, z.agencyId],
        }),
      ),
    );
    expect(shared.access?.agencyNames).toEqual({
      [x.agencyId]: `Xanadu ${RUN} S.L.`,
      [y.agencyId]: `Yucca ${RUN} S.L.`,
      [z.agencyId]: `Zenit ${RUN} S.L.`,
    });

    search.configureSearchIndex({ uid: UID, scope: unitIds });
    await search.ensureListingsIndex(real(), search.listingsIndex(UID));
    await republish();
    search.configureNetworkSearch({ giveToGetMinShared: 0 });

    for (const m of [x, y, z]) expect(await found(m)).toEqual([...unitIds].sort());
    expect(await found(w)).toEqual([]);
    expect(await found(d)).toEqual([]); // never the caller's own

    // The development and its unit table: the three read them, the fourth does not.
    for (const m of [x, y, z]) {
      expect((await as(m, (ctx) => developments.getDevelopment(ctx, devId))).access).toBeNull();
      expect((await as(m, (ctx) => developments.listUnits(ctx, devId, { limit: 100 }))).items).toHaveLength(3);
    }
    expect(await refusal(as(w, (ctx) => developments.getDevelopment(ctx, devId)))).toBe('DEVELOPMENT_NOT_FOUND');
    // A named agency reads the development but never writes it: no Kyero upload into it.
    const one = kyeroFile([property('R-2', `Villa ${RUN}`)]);
    expect(await refusal(developments.readKyeroUnits(runner(x), devId, one))).toBe('FORBIDDEN');
    expect(await refusal(as(w, (ctx) => developments.listUnits(ctx, devId, { limit: 100 })))).toBe(
      'DEVELOPMENT_NOT_FOUND',
    );
  });

  it('[R2-07] the owner in Client Mode sees no sharing settings; an agency outside the directory cannot be named', async () => {
    const inClient = await withMemberCtx(
      { userId: d.userId, agencyId: d.agencyId, requestId: newId(), locale: 'en', clientMode: true },
      (ctx) => developments.getDevelopment(ctx, devId),
    );
    expect(inClient.access).toBeNull();
    const pending = await createFounder({ companyName: `Pending ${RUN} S.L.` }); // not verified: not in the directory
    const dev = await as(d, (ctx) => developments.getDevelopment(ctx, devId));
    const refused = await as(d, (ctx) =>
      developments.setDevelopmentAccess(
        ctx,
        devId,
        SetDevelopmentAccessBody.parse({
          version: dev.version,
          kind: 'PRIVATE_NETWORK',
          allowedAgencyIds: [x.agencyId, pending.agencyId],
        }),
      ),
    ).then(
      () => null,
      (err: { code?: string; details?: unknown }) => ({ code: err.code, details: err.details }),
    );
    expect(refused).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { field: 'allowedAgencyIds', reason: 'unknown' },
    });
    expect((await as(d, (ctx) => developments.getDevelopment(ctx, devId))).access?.allowedAgencyIds.sort()).toEqual(
      [x.agencyId, y.agencyId, z.agencyId].sort(),
    );
  });

  it('[R2-07] RLS keeps the read models from the 4th agency even if the index still held them', async () => {
    const visible = (m: Founder) =>
      as(m, async (ctx) =>
        Number(
          (
            await ctx.tx.execute<{ n: string }>(
              sql`select count(*)::text as n from listing_read_models where target_id in (${sql.join(
                unitIds.map((u) => sql`${u}`),
                sql`, `,
              )})`,
            )
          ).rows[0]?.n,
        ),
      );
    expect(await visible(w)).toBe(0);
    expect(await visible(x)).toBeGreaterThanOrEqual(3);
  });

  it('[R2-07] an agency taken off the list stops finding it; the owner view names those left', async () => {
    const dev = await as(d, (ctx) => developments.getDevelopment(ctx, devId));
    await as(d, (ctx) =>
      developments.setDevelopmentAccess(
        ctx,
        devId,
        SetDevelopmentAccessBody.parse({
          version: dev.version,
          kind: 'PRIVATE_NETWORK',
          allowedAgencyIds: [x.agencyId, y.agencyId],
        }),
      ),
    );
    // Before the index catches up, RLS already hides the read models from z: the result drops them.
    expect(await found(z)).toEqual([]);
    await republish();
    expect(await found(z)).toEqual([]);
    expect(await found(x)).toEqual([...unitIds].sort());
    const view = await as(d, (ctx) => developments.getDevelopment(ctx, devId));
    expect(view.access?.agencyNames).toEqual({ [x.agencyId]: `Xanadu ${RUN} S.L.`, [y.agencyId]: `Yucca ${RUN} S.L.` });
  });

  it('[R2-07] network search: ≤ 10 statements, no Seq Scan on a large table, each statement timed', async () => {
    const body = { limit: 50, newBuilds: true } as const;
    for (let i = 0; i < 3; i++) await search.searchNetwork(runner(x), body); // warm pool and caches
    const statements: { query: string; params: unknown[] }[] = [];
    const count = await countQueries(() => search.searchNetwork(runner(x), body), {
      onQuery: (query, params) => statements.push({ query, params }),
    });
    expect(count).toBeLessThanOrEqual(10);
    // Each statement as the viewer's request ran it (app_user, its agency and user), EXPLAIN ANALYZEd 20 times.
    const report = await withAdminRollback([], async (q) => {
      await q(`select set_config('app.agency_id', $1, true), set_config('app.user_id', $2, true)`, [
        x.agencyId,
        x.userId,
      ]);
      await q('set local role app_user');
      const out: { statement: string; p50: number; p95: number; seq: string[] }[] = [];
      for (const s of statements) {
        const times: number[] = [];
        let plan = '';
        for (let i = 0; i < 20; i++) {
          const rows = await q(`explain (analyze, buffers, costs off) ${s.query}`, s.params);
          plan = rows.map((r) => String(Object.values(r)[0])).join(' | ');
          times.push(Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1]));
        }
        times.sort((a, b) => a - b);
        out.push({
          statement: s.query.replace(/\s+/g, ' ').trim().slice(0, 80),
          p50: times[9] as number,
          p95: times[18] as number,
          seq: [...plan.matchAll(/Seq Scan on (\w+)/g)].map((m) => m[1] as string),
        });
      }
      return out;
    });
    for (const r of report)
      console.info(
        `[R2-07] p50 ${r.p50.toFixed(2)} p95 ${r.p95.toFixed(2)} ms · seq [${r.seq.join(', ')}] · ${r.statement}`,
      );
    // The budget's rule: no Seq Scan on a table over 10k rows (small lookup tables may be scanned; the planner
    // scans the test database's small developments / access tables, which an index serves once they grow).
    const scanned = [...new Set(report.flatMap((r) => r.seq))];
    const sizes = await withAdminRollback([], (q) =>
      q(`select relname, reltuples::bigint::text as n from pg_class where relname = any($1)`, [scanned]),
    );
    console.info(`[R2-07] scanned tables ${sizes.map((r) => `${r.relname}=${r.n}`).join(', ')}`);
    expect(sizes.filter((r) => Number(r.n) > 10_000).map((r) => r.relname)).toEqual([]);
    // The median is asserted (other test files load the shared stack in parallel and spike single runs); the p95 is
    // reported above — measured alone it is a few ms (STATUS R2-07a).
    expect(Math.max(...report.map((r) => r.p50))).toBeLessThan(20);
  });
});
