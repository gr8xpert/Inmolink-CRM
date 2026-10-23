import { CreateUnitsBody } from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as taxonomy from '../../taxonomy';
import * as developments from '../index';

/** Feed developments in batches (S8-F3): a fixed number of statements per batch, units the feed drops withdrawn. */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];

let owner: Founder;
let ids: { location: string; location2: string; type: string };

const as = <T>(fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: owner.userId, agencyId: owner.agencyId, requestId: newId(), locale: 'en' }, fn);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('developments.feed.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

const unit = (ref: string, priceCents: number | null): developments.FeedUnitInput => ({
  ref,
  propertyTypeId: ids.type,
  priceCents,
  internalM2: 80,
  terraceM2: 12.5,
  bedrooms: 2,
  bathrooms: 1,
  status: 'AVAILABLE',
});

/** `n` developments under `prefix`: two units at first; then renamed, moved, one unit repriced, one dropped, one new. */
function batch(prefix: string, n: number, pass: 1 | 2): developments.FeedDevelopmentInput[] {
  return Array.from({ length: n }, (_, i) => ({
    ref: code(`${prefix}-${i}`),
    name: pass === 1 ? `Dev ${i}` : `Dev ${i} renamed`,
    keyReady: pass === 2,
    locationId: pass === 1 ? ids.location : ids.location2,
    currency: 'EUR',
    units: pass === 1 ? [unit('U1', 100_000), unit('U2', 200_000)] : [unit('U1', 110_000), unit('U3', 300_000)],
  }));
}

/** One import counted; in `inside`'s transaction when given (rolled back by the caller), else its own. */
async function run(inputs: developments.FeedDevelopmentInput[], inside?: Ctx) {
  let result: developments.FeedDevelopmentsResult | undefined;
  const counted = (ctx: Ctx) =>
    countQueries(async () => {
      result = await developments.importFeedDevelopments(ctx, inputs);
    });
  const statements = await (inside ? counted(inside) : as(counted));
  return { statements, result: result as developments.FeedDevelopmentsResult };
}

class Rollback extends Error {}

/** `fn` in one member transaction that is rolled back: thousands of events no other suite ever sees or claims. */
const rolledBack = (fn: (ctx: Ctx) => Promise<void>) =>
  as(async (ctx) => {
    await fn(ctx);
    throw new Rollback();
  }).catch((err: unknown) => {
    if (!(err instanceof Rollback)) throw err;
  });

beforeAll(async () => {
  await setupTestDb('worker');
  owner = await createFounder();
  ids = await system(async (tx) => {
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('fd'),
      translations: tr(`Feedland ${RUN}`, 'feedland'),
    });
    const location2 = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: location,
      code: code('fd-r'),
      translations: tr(`Feed coast ${RUN}`, 'feed-coast'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('fd-g'),
      sort: 0,
      translations: tr(`Homes ${RUN}`, 'fd-g'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('fd-flat'),
      sort: 0,
      translations: tr(`Flat ${RUN}`, 'fd-flat'),
    });
    return { location, location2, type };
  });
}, 120_000);

afterAll(async () => {
  // The batches leave thousands of events nobody here dispatches: settle them so they take no other suite's claims.
  await system((tx) =>
    tx.execute(
      sql`update outbox_events set processed_at = now() where agency_id = ${owner.agencyId} and processed_at is null`,
    ),
  );
  await closeDb();
});

describe('feed developments (S8-F3)', () => {
  it('[S8-F3] a 500-development batch runs a fixed number of statements, independent of the batch size', () =>
    rolledBack(async (ctx) => {
      const read = async <T>(q: ReturnType<typeof sql>) => (await ctx.tx.execute(q)).rows as T[];
      // Creating: 5 developments and 500 developments, two units each.
      const small1 = await run(batch('S', 5, 1), ctx);
      const big1 = await run(batch('B', 500, 1), ctx);
      expect(big1.result).toMatchObject({
        developments: { created: 500, updated: 0, unchanged: 0 },
        units: { created: 1000, updated: 0, unchanged: 0, withdrawn: 0 },
        skipped: new Map(),
      });
      expect(big1.statements).toBe(small1.statements);
      // lock by reference, units, developments, units, history ×2, outbox
      expect(big1.statements).toBeLessThanOrEqual(7);

      // Changing every development: renamed, moved, key-ready, one unit repriced, one dropped, one new.
      const small2 = await run(batch('S', 5, 2), ctx);
      const big2 = await run(batch('B', 500, 2), ctx);
      expect(big2.result).toMatchObject({
        developments: { created: 0, updated: 500, unchanged: 0 },
        units: { created: 500, updated: 500, unchanged: 0, withdrawn: 500 },
      });
      expect(big2.statements).toBe(small2.statements);
      // lock, units, update developments, insert units, update units, delete units, history ×2, outbox
      expect(big2.statements).toBeLessThanOrEqual(9);
      const stored = await read<{ n: number; names: number; moved: number; keyReady: number }>(sql`
      select count(*)::int as n,
             count(*) filter (where name like '% renamed')::int as names,
             count(*) filter (where location_id = ${ids.location2})::int as moved,
             count(*) filter (where status = 'KEY_READY')::int as "keyReady"
        from developments where agency_id = ${owner.agencyId} and ref like ${`B-%-${RUN}`}`);
      expect(stored[0]).toEqual({ n: 500, names: 500, moved: 500, keyReady: 500 });
      const units = await read<{ ref: string; price: string; n: number }>(sql`
      select u.ref, u.price_cents as price, count(*)::int as n
        from units u join developments d on d.id = u.development_id
       where d.agency_id = ${owner.agencyId} and d.ref like ${`B-%-${RUN}`}
       group by u.ref, u.price_cents order by u.ref`);
      expect(units).toEqual([
        { ref: 'U1', price: '110000', n: 500 },
        { ref: 'U3', price: '300000', n: 500 },
      ]);

      // The same input again writes nothing: the two reads only.
      const big3 = await run(batch('B', 500, 2), ctx);
      expect(big3.result).toMatchObject({
        developments: { created: 0, updated: 0, unchanged: 500 },
        units: { created: 0, updated: 0, unchanged: 1000, withdrawn: 0 },
      });
      expect(big3.statements).toBe(2);
    }));

  it('[S8-F3] a development over the unit limit is skipped alone; an empty price list withdraws nothing', async () => {
    const full = Array.from({ length: 2_001 }, (_, i) => unit(`X${i}`, null));
    const r = await run([
      { ...batch('L', 1, 1)[0], units: full } as developments.FeedDevelopmentInput,
      ...batch('L-ok', 1, 1),
    ]);
    expect([...r.result.skipped]).toEqual([[code('L-0'), 'DEVELOPMENT_UNIT_LIMIT']]);
    expect(r.result.developments.created).toBe(1);
    const empty = await run([{ ...(batch('L-ok', 1, 1)[0] as developments.FeedDevelopmentInput), units: [] }]);
    expect(empty.result.units).toEqual({ created: 0, updated: 0, unchanged: 0, withdrawn: 0 });
    const left = await rows<{ n: number }>(sql`
      select count(*)::int as n from units u join developments d on d.id = u.development_id
       where d.agency_id = ${owner.agencyId} and d.ref = ${code('L-ok-0')}`);
    expect(left[0]?.n).toBe(2);
  });

  it('[S8-F3] when the batch write fails, each development is written in its own savepoint: only the bad one is skipped', async () => {
    const [good, bad] = batch('F', 2, 1) as [developments.FeedDevelopmentInput, developments.FeedDevelopmentInput];
    // An unknown property type fails the units insert (foreign key) for the whole batch first.
    const r = await run([good, { ...bad, units: [{ ...unit('U1', 1), propertyTypeId: newId() }] }]);
    expect([...r.result.skipped]).toEqual([[bad.ref, 'VALIDATION_FAILED']]);
    expect(r.result.developments.created).toBe(1);
    const stored = await rows<{ ref: string; units: number }>(sql`
      select d.ref, (select count(*)::int from units u where u.development_id = d.id) as units
        from developments d where d.agency_id = ${owner.agencyId} and d.ref like ${`F-%-${RUN}`}`);
    expect(stored).toEqual([{ ref: good.ref, units: 2 }]);
  });
  it('[S8-F3] only AVAILABLE units the feed created are withdrawn: an omitted SOLD unit and a hand-added unit stay; a truncated list withdraws nothing', async () => {
    const ref = code('K');
    const dev = (units: developments.FeedUnitInput[]): developments.FeedDevelopmentInput => ({
      ref,
      name: 'Keep',
      keyReady: false,
      locationId: ids.location,
      currency: 'EUR',
      units,
    });
    const k = (n: number) => unit(`K${n}`, n * 1_000);
    const sold = { ...unit('K7', 7_000), status: 'SOLD' as const };
    await run([dev([k(1), k(2), k(3), k(4), k(5), k(6), sold])]);
    const [made] = await rows<{ id: string }>(
      sql`select id from developments where agency_id = ${owner.agencyId} and ref = ${ref}`,
    );
    await as((ctx) =>
      developments.createUnits(
        ctx,
        made?.id as string,
        CreateUnitsBody.parse({ units: [{ ref: 'H1', propertyTypeId: ids.type }] }),
      ),
    );
    const refs = async () =>
      (
        await rows<{ ref: string }>(
          sql`select ref from units where development_id = ${made?.id as string} order by ref`,
        )
      ).map((r) => r.ref);

    // K5 (AVAILABLE, the feed's) is withdrawn; K7 (SOLD) and H1 (added by hand) are not in the list but stay.
    const second = await run([dev([k(1), k(2), k(3), k(4), k(6)])]);
    expect(second.result.units.withdrawn).toBe(1);
    expect(second.result.held.size).toBe(0);
    expect(await refs()).toEqual(['H1', 'K1', 'K2', 'K3', 'K4', 'K6', 'K7']);

    // A list naming one of the six feed units would drop four of them: held, nothing withdrawn, reported.
    const truncated = await run([dev([k(1)])]);
    expect(truncated.result.units.withdrawn).toBe(0);
    expect([...truncated.result.held]).toEqual([[ref, { dropped: 4, feedUnits: 6 }]]);
    expect(await refs()).toEqual(['H1', 'K1', 'K2', 'K3', 'K4', 'K6', 'K7']);
  });
});

describe('feed field locks (S8-F5)', () => {
  const stored = (prefix: string) =>
    rows<{ ref: string; name: string; locationId: string; fromFeed: boolean; lockedFields: string[] }>(sql`
      select ref, name, location_id as "locationId", from_feed as "fromFeed", locked_fields as "lockedFields"
        from developments where agency_id = ${owner.agencyId} and ref like ${`${prefix}-%-${RUN}`} order by ref`);
  const idOf = async (ref: string) =>
    (
      await rows<{ id: string; version: number }>(
        sql`select id, version from developments where agency_id = ${owner.agencyId} and ref = ${ref}`,
      )
    )[0] as { id: string; version: number };

  it("[S8-F5] a renamed feed development keeps the owner's name after the next run while an unlocked one follows the feed", async () => {
    await run(batch('R', 2, 1));
    const a = await idOf(code('R-0'));
    // Renaming by hand locks the name (the location, not edited, stays the feed's).
    const renamed = await as((ctx) =>
      developments.updateDevelopment(ctx, a.id, { version: a.version, name: 'Owner name' }),
    );
    expect(renamed.feed).toEqual({ lockedFields: ['name'] });

    const second = await run(batch('R', 2, 2));
    expect(second.result.developments).toEqual({ created: 0, updated: 2, unchanged: 0 });
    expect(await stored('R')).toEqual([
      { ref: code('R-0'), name: 'Owner name', locationId: ids.location2, fromFeed: true, lockedFields: ['name'] },
      { ref: code('R-1'), name: 'Dev 1 renamed', locationId: ids.location2, fromFeed: true, lockedFields: [] },
    ]);
    // Idempotent with the lock: the same input again writes nothing.
    const third = await run(batch('R', 2, 2));
    expect(third.result.developments).toEqual({ created: 0, updated: 0, unchanged: 2 });

    // Locking the location too, then unlocking the name: the feed takes the name back, the place stays.
    const b = await idOf(code('R-0'));
    const relocked = await as((ctx) =>
      developments.updateDevelopment(ctx, b.id, { version: b.version, locationId: ids.location }),
    );
    expect(relocked.feed).toEqual({ lockedFields: ['location', 'name'] });
    const c = await idOf(code('R-0'));
    await as((ctx) => developments.updateDevelopment(ctx, c.id, { version: c.version, lockedFields: ['location'] }));
    await run(batch('R', 2, 2));
    expect((await stored('R'))[0]).toMatchObject({ name: 'Dev 0 renamed', locationId: ids.location });
  });

  it('[S8-F5] a feed adopting a development made by hand keeps its name and location and locks each one the feed disagrees with', async () => {
    const ref = code('M-0');
    const made = await as((ctx) =>
      developments.createDevelopment(ctx, { ref, name: 'By hand', locationId: ids.location }),
    );
    expect(made.feed).toBeNull();
    const edited = await as((ctx) =>
      developments.updateDevelopment(ctx, made.id, { version: made.version, name: 'By hand 2' }),
    );
    expect(edited.feed).toBeNull();
    // The feed sends another name ('Dev 0') and the same place: the name is kept and locked, the place stays open.
    const first = await run(batch('M', 1, 1));
    expect(first.result.developments).toEqual({ created: 0, updated: 1, unchanged: 0 });
    const adopted = await as((ctx) => developments.getDevelopment(ctx, made.id));
    expect(adopted).toMatchObject({ name: 'By hand 2', locationId: ids.location, feed: { lockedFields: ['name'] } });
    // From then on a feed development: the next run moves the open field only, and is idempotent after.
    await run(batch('M', 1, 2));
    expect(await as((ctx) => developments.getDevelopment(ctx, made.id))).toMatchObject({
      name: 'By hand 2',
      locationId: ids.location2,
    });
    expect((await run(batch('M', 1, 2))).result.developments.unchanged).toBe(1);
  });

  it('[S8-F5] locks can be sent only for a feed development, and sending the locks it already has writes nothing', async () => {
    const hand = await as((ctx) =>
      developments.createDevelopment(ctx, { ref: code('V-hand'), name: 'Hand', locationId: ids.location }),
    );
    await expect(
      as((ctx) => developments.updateDevelopment(ctx, hand.id, { version: hand.version, lockedFields: ['name'] })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await run(batch('V', 1, 1));
    const dev = await idOf(code('V-0'));
    const locked = await as((ctx) =>
      developments.updateDevelopment(ctx, dev.id, { version: dev.version, lockedFields: ['location', 'name'] }),
    );
    expect(locked).toMatchObject({ version: dev.version + 1, feed: { lockedFields: ['location', 'name'] } });
    const again = await as((ctx) =>
      developments.updateDevelopment(ctx, dev.id, { version: locked.version, lockedFields: ['name', 'location'] }),
    );
    expect(again.version).toBe(locked.version);
    expect((await idOf(code('V-0'))).version).toBe(locked.version);
  });

  it('[S8-F5] the database refuses a lock on a field no feed owns', async () => {
    const dev = await idOf(code('V-0'));
    await expect(
      system((tx) => tx.execute(sql`update developments set locked_fields = '{price}' where id = ${dev.id}`)),
    ).rejects.toMatchObject({ cause: { constraint: 'developments_locked_fields_ck' } });
  });

  it('[S8-F5] the batch still runs a fixed number of statements with locks present', () =>
    rolledBack(async (ctx) => {
      await run(batch('LS', 5, 1), ctx);
      await run(batch('LB', 300, 1), ctx);
      // Every other development locks its name and location.
      const locked = [...batch('LS', 5, 1), ...batch('LB', 300, 1)].filter((_, i) => i % 2 === 0).map((d) => d.ref);
      await ctx.tx.execute(sql`
        update developments set locked_fields = '{location,name}'
         where agency_id = ${owner.agencyId} and ref in (${sql.join(
           locked.map((r) => sql`${r}`),
           sql`, `,
         )})`);
      const small = await run(batch('LS', 5, 2), ctx);
      const big = await run(batch('LB', 300, 2), ctx);
      expect(big.statements).toBe(small.statements);
      expect(big.statements).toBeLessThanOrEqual(9);
      // Locked ones turn key-ready (status is not lockable) but keep their name and place; the others follow.
      expect(big.result.developments).toEqual({ created: 0, updated: 300, unchanged: 0 });
      const r = (
        await ctx.tx.execute(sql`
        select count(*) filter (where name like '% renamed')::int as renamed,
               count(*) filter (where location_id = ${ids.location2})::int as moved,
               count(*) filter (where status = 'KEY_READY')::int as "keyReady"
          from developments where agency_id = ${owner.agencyId} and ref like ${`LB-%-${RUN}`}`)
      ).rows[0];
      expect(r).toEqual({ renamed: 150, moved: 150, keyReady: 300 });
      const again = await run(batch('LB', 300, 2), ctx);
      expect(again.statements).toBe(2);
    }));
});
