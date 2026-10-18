import {
  BulkUpdateUnitsBody,
  CreateDevelopmentBody,
  CreatePriceListBody,
  CreateUnitsBody,
  type DevelopmentDto,
  type UnitDto,
  UpdateUnitBody,
} from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as agencies from '../../agencies';
import * as taxonomy from '../../taxonomy';
import * as developments from '../index';

/** Development use cases on the real database (S4-02). */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];

type Member = { userId: string; agencyId: string };
let owner: Founder;
let agent: Member;
let allowed: Founder;
let stranger: Founder;
let ids: { location: string; type: string };

const as = <T>(m: Member, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (err: { code?: string }) => err.code ?? String(err),
  );
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('developments.service.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const eventsOf = (key: string, id: string) =>
  rows<{ type: string; payload: Record<string, unknown> }>(
    sql`select type, payload from outbox_events where payload->>${key} = ${id} order by id`,
  );

let seq = 0;
const createDev = (m: Member = owner, body: Partial<CreateDevelopmentBody> = {}) =>
  as(m, (ctx) =>
    developments.createDevelopment(
      ctx,
      CreateDevelopmentBody.parse({
        ref: code(`D${++seq}`),
        name: 'Marbella Heights',
        locationId: ids.location,
        commission: { type: 'PCT', basisPoints: 500, includesVat: false },
        ...body,
      }),
    ),
  );
const unit = (ref: string, priceCents: number | null, over: Record<string, unknown> = {}) => ({
  ref,
  propertyTypeId: ids.type,
  bedrooms: 2,
  priceCents,
  ...over,
});
const addUnits = (dev: Pick<DevelopmentDto, 'id'>, us: ReturnType<typeof unit>[], m: Member = owner) =>
  as(m, (ctx) => developments.createUnits(ctx, dev.id, CreateUnitsBody.parse({ units: us }))).then((l) => l.items);
const byRef = (us: UnitDto[]) => Object.fromEntries(us.map((u) => [u.ref, u]));

beforeAll(async () => {
  await setupTestDb('worker');
  [owner, allowed, stranger] = await Promise.all([createFounder(), createFounder(), createFounder()]);
  for (const f of [owner, allowed, stranger]) await setAgencyStatus(f.agencyId, 'VERIFIED');
  const agentId = newId();
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${agentId}, ${`dev-agent-${agentId}@example.com`}, 'x', 'Agent', 'es', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${owner.agencyId}, ${agentId}, 'AGENT', 'Agent', ${`dev-agent-${agentId}@example.com`})`);
  });
  agent = { userId: agentId, agencyId: owner.agencyId };
  ids = await system(async (tx) => {
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('ds'),
      translations: tr(`Devserv ${RUN}`, 'devserv'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('ds-flats'),
      sort: 0,
      translations: tr(`Flats ${RUN}`, 'ds-flats'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('ds-apartment'),
      sort: 0,
      translations: tr(`Apartment ${RUN}`, 'ds-apartment'),
    });
    return { location, type };
  });
}, 120_000);

afterAll(closeDb);

describe('development service', () => {
  it('[S4-02] uploading a new price list version produces a diff (added/removed/changed units and prices)', async () => {
    const dev = await createDev();
    const before = byRef(
      await addUnits(dev, [unit('A1', 30_000_000), unit('A2', 31_000_000), unit('A3', 32_000_000), unit('A4', null)]),
    );
    const upload = (entries: unknown[]) =>
      as(owner, (ctx) =>
        developments.createPriceList(
          ctx,
          dev.id,
          CreatePriceListBody.parse({ effectiveFrom: '2026-11-01', extractedBy: 'AI', entries }),
        ),
      );
    const v1 = await upload([
      { ref: 'A1', priceCents: 30_000_000 }, // unchanged
      { ref: 'A2', priceCents: 33_500_000 }, // price up
      { ref: 'A3', priceCents: 32_000_000, status: 'RESERVED' }, // status only
      { ref: 'B1', priceCents: 45_000_000 }, // new reference
      // A4 left out: removed
    ]);
    expect(v1).toMatchObject({ version: 1, extractedBy: 'AI', reviewedAt: null });
    expect(v1.diff).toEqual({
      added: [{ ref: 'B1', priceCents: 45_000_000 }],
      removed: [{ unitId: before.A4?.id, ref: 'A4', priceCents: null }],
      changed: [
        { unitId: before.A2?.id, ref: 'A2', priceCents: { from: 31_000_000, to: 33_500_000 }, status: null },
        { unitId: before.A3?.id, ref: 'A3', priceCents: null, status: { from: 'AVAILABLE', to: 'RESERVED' } },
      ],
      unchanged: 1,
    });
    // An upload changes nothing until it is approved.
    const listed = await as(owner, (ctx) => developments.listUnits(ctx, dev.id, { limit: 100 }));
    expect(byRef(listed.items).A2?.price?.amountCents).toBe(31_000_000);
    expect((await eventsOf('priceListId', v1.id)).map((e) => e.type)).toEqual(['developments.priceList.created']);

    // A newer version supersedes it; the agent may upload but not approve.
    const v2 = await upload([
      { ref: 'A1', priceCents: 30_000_000 },
      { ref: 'A2', priceCents: 33_500_000 },
      { ref: 'A3', priceCents: 32_000_000, status: 'RESERVED' },
      { ref: 'A4', priceCents: 50_000_000 },
    ]);
    expect(v2.version).toBe(2);
    expect(await refusal(as(owner, (ctx) => developments.approvePriceList(ctx, dev.id, 1)))).toBe(
      'PRICE_LIST_SUPERSEDED',
    );
    expect(await refusal(as(agent, (ctx) => developments.approvePriceList(ctx, dev.id, 2)))).toBe('FORBIDDEN');

    const approved = await as(owner, (ctx) => developments.approvePriceList(ctx, dev.id, 2));
    expect(approved.reviewedByUserId).toBe(owner.userId);
    expect(approved.diff.changed.map((c) => c.ref)).toEqual(['A2', 'A3', 'A4']);
    const after = byRef((await as(owner, (ctx) => developments.listUnits(ctx, dev.id, { limit: 100 }))).items);
    expect(after.A2?.price?.amountCents).toBe(33_500_000);
    expect(after.A3?.status).toBe('RESERVED');
    expect(after.A4?.price?.amountCents).toBe(50_000_000);
    expect(await refusal(as(owner, (ctx) => developments.approvePriceList(ctx, dev.id, 2)))).toBe(
      'PRICE_LIST_REVIEWED',
    );
    // History names the version that changed the price and the status.
    const history = await rows<{ n: number }>(
      sql`select (select count(*)::int from unit_price_histories where price_list_id = ${approved.id})
        + (select count(*)::int from unit_status_histories where price_list_id = ${approved.id}) as n`,
    );
    expect(history[0]?.n).toBe(3);
    expect((await as(owner, (ctx) => developments.getDevelopment(ctx, dev.id))).lastVerifiedAt).not.toBeNull();
    const page = await as(owner, (ctx) => developments.listPriceLists(ctx, dev.id, { limit: 1 }));
    expect(page.items.map((p) => p.version)).toEqual([2]);
    const next = await as(owner, (ctx) =>
      developments.listPriceLists(ctx, dev.id, { limit: 1, cursor: page.nextCursor ?? '' }),
    );
    expect(next).toMatchObject({ items: [{ version: 1 }], nextCursor: null });
  });

  it('[S4-F5] a list of price lists carries the diff counts only; one version carries the full diff', async () => {
    const dev = await createDev();
    await addUnits(dev, [unit('C1', 10_000_000), unit('C2', 11_000_000), unit('C3', 12_000_000)]);
    const v1 = await as(owner, (ctx) =>
      developments.createPriceList(
        ctx,
        dev.id,
        CreatePriceListBody.parse({
          effectiveFrom: '2026-11-01',
          entries: [
            { ref: 'C1', priceCents: 10_000_000 },
            { ref: 'C2', priceCents: 11_500_000 },
            { ref: 'D1', priceCents: 20_000_000 },
          ],
        }),
      ),
    );
    const page = await as(owner, (ctx) => developments.listPriceLists(ctx, dev.id, { limit: 10 }));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.counts).toEqual({ added: 1, removed: 1, changed: 1, unchanged: 1 });
    expect(page.items[0]).not.toHaveProperty('diff');
    const one = await as(owner, (ctx) => developments.getPriceList(ctx, dev.id, 1));
    expect(one.diff).toEqual(v1.diff);
    expect(one).not.toHaveProperty('counts');
  });

  it('[S4-02] unit status change emits an event within the same transaction', async () => {
    const dev = await createDev();
    const [u] = await addUnits(dev, [unit('S1', 40_000_000)]);
    if (!u) throw new Error('no unit');
    const reserve = (ctx: Ctx) =>
      developments.updateUnit(ctx, dev.id, u.id, UpdateUnitBody.parse({ version: u.version, status: 'RESERVED' }));

    // Rolled back with the change: neither the status nor the event remains.
    const rollback = new Error('rollback');
    await expect(
      as(owner, async (ctx) => {
        await reserve(ctx);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    const typesOf = async () => (await eventsOf('unitId', u.id)).map((e) => e.type);
    expect(await typesOf()).toEqual(['developments.unit.created']);

    const reserved = await as(owner, reserve);
    expect(reserved).toMatchObject({ status: 'RESERVED', version: u.version + 1 });
    const events = await eventsOf('unitId', u.id);
    expect(events.map((e) => e.type)).toEqual([
      'developments.unit.created',
      'developments.unit.updated',
      'developments.unit.statusChanged',
    ]);
    expect(events[2]?.payload).toMatchObject({ developmentId: dev.id, from: 'AVAILABLE', to: 'RESERVED', version: 2 });
    const history = await rows<{ from_status: string | null; to_status: string }>(
      sql`select from_status, to_status from unit_status_histories where unit_id = ${u.id} order by changed_at, id`,
    );
    expect(history).toEqual([
      { from_status: null, to_status: 'AVAILABLE' },
      { from_status: 'AVAILABLE', to_status: 'RESERVED' },
    ]);
    // Stale version → 409.
    expect(await refusal(as(owner, reserve))).toBe('VERSION_CONFLICT');
  });

  it('[S4-02] bulk unit edits change many units in a fixed number of statements, with history and events', async () => {
    const dev = await createDev();
    const us = await addUnits(dev, [unit('C1', 1_000), unit('C2', 2_000), unit('C3', 3_000), unit('C4', 4_000)]);
    const three = us.slice(0, 3).map((u) => u.id);
    let result: { items: UnitDto[] } = { items: [] };
    const queries = await as(agent, (ctx) =>
      countQueries(async () => {
        result = await developments.bulkUpdateUnits(
          ctx,
          dev.id,
          BulkUpdateUnitsBody.parse({ unitIds: three, patch: { status: 'SOLD', priceCents: 5_000 } }),
        );
      }),
    );
    expect(result.items.map((u) => [u.ref, u.status, u.price?.amountCents])).toEqual([
      ['C1', 'SOLD', 5_000],
      ['C2', 'SOLD', 5_000],
      ['C3', 'SOLD', 5_000],
    ]);
    // lock development, lock units, update, status history, price history, events
    expect(queries).toBeLessThanOrEqual(6);
    const changes = await rows<{ n: number }>(sql`select count(*)::int as n from outbox_events
      where payload->>'developmentId' = ${dev.id} and type in ('developments.unit.statusChanged', 'developments.unit.priceChanged')`);
    expect(changes[0]?.n).toBe(6);
    // Commission is the admin's; units of another development are not found.
    expect(
      await refusal(
        as(agent, (ctx) =>
          developments.bulkUpdateUnits(
            ctx,
            dev.id,
            BulkUpdateUnitsBody.parse({ unitIds: three, patch: { commission: null } }),
          ),
        ),
      ),
    ).toBe('FORBIDDEN');
    const other = await createDev();
    expect(
      await refusal(
        as(owner, (ctx) =>
          developments.bulkUpdateUnits(
            ctx,
            other.id,
            BulkUpdateUnitsBody.parse({ unitIds: three, patch: { status: 'AVAILABLE' } }),
          ),
        ),
      ),
    ).toBe('UNIT_NOT_FOUND');
  });

  it('[S4-02] developer commission per development or unit; the network reads it, Client Mode never', async () => {
    const dev = await createDev();
    expect(dev.commission).toEqual({ type: 'PCT', basisPoints: 500, includesVat: false });
    const [u] = await addUnits(dev, [
      unit('K1', 60_000_000, {
        commission: { type: 'FIXED', amount: { amountCents: 1_500_000, currency: 'EUR' }, includesVat: true },
      }),
    ]);
    expect(u?.commission).toMatchObject({ type: 'FIXED', amount: { amountCents: 1_500_000 } });
    expect(
      await refusal(
        addUnits(dev, [unit('K2', 1, { commission: { type: 'PCT', basisPoints: 300, includesVat: false } })], agent),
      ),
    ).toBe('FORBIDDEN');
    expect(await refusal(addUnits(dev, [unit('K1', 1)]))).toBe('UNIT_REF_TAKEN');

    // Shared with one agency: it reads the development and units (with commission); others see nothing.
    const shared = await as(owner, (ctx) =>
      developments.setDevelopmentAccess(ctx, dev.id, {
        version: dev.version,
        kind: 'PRIVATE_NETWORK',
        allowedAgencyIds: [allowed.agencyId],
      }),
    );
    expect(shared.access).toEqual({ kind: 'PRIVATE_NETWORK', allowedAgencyIds: [allowed.agencyId] });
    // S4-F5: an agency that does not exist is a validation error, not a 500.
    expect(
      await as(owner, (ctx) =>
        developments.setDevelopmentAccess(ctx, dev.id, {
          version: shared.version,
          kind: 'PRIVATE_NETWORK',
          allowedAgencyIds: [newId()],
        }),
      ).then(
        () => null,
        (err: { code?: string; details?: unknown }) => ({ code: err.code, details: err.details }),
      ),
    ).toEqual({ code: 'VALIDATION_FAILED', details: { field: 'allowedAgencyIds', reason: 'unknown' } });
    const network = await as(allowed, (ctx) => developments.getDevelopment(ctx, dev.id));
    expect(network).toMatchObject({ access: null, commission: { basisPoints: 500 } });
    const units = await as(allowed, (ctx) => developments.listUnits(ctx, dev.id, { limit: 10 }));
    expect(units.items[0]?.commission).toMatchObject({ type: 'FIXED' });
    const client = await as(allowed, (ctx) =>
      developments.listUnits({ ...ctx, clientMode: true }, dev.id, { limit: 10 }),
    );
    expect(client.items[0]?.commission).toBeNull();
    const clientDev = await as(allowed, (ctx) => developments.getDevelopment({ ...ctx, clientMode: true }, dev.id));
    expect(clientDev).toMatchObject({ agencyId: null, commission: null });
    expect(await refusal(as(stranger, (ctx) => developments.getDevelopment(ctx, dev.id)))).toBe(
      'DEVELOPMENT_NOT_FOUND',
    );

    // Only the owner writes; price lists stay with the owner.
    expect(
      await refusal(
        as(allowed, (ctx) =>
          developments.updateUnit(ctx, dev.id, u?.id ?? '', UpdateUnitBody.parse({ version: 1, status: 'SOLD' })),
        ),
      ),
    ).toBe('FORBIDDEN');
    expect(await refusal(as(allowed, (ctx) => developments.listPriceLists(ctx, dev.id, { limit: 10 })))).toBe(
      'FORBIDDEN',
    );
    expect(await refusal(as(stranger, (ctx) => developments.updateDevelopment(ctx, dev.id, { version: 2 })))).toBe(
      'DEVELOPMENT_NOT_FOUND',
    );

    const changed = await as(owner, (ctx) =>
      developments.updateDevelopment(ctx, dev.id, {
        version: shared.version,
        commission: { type: 'PCT', basisPoints: 400, includesVat: true },
      }),
    );
    expect(changed.commission).toEqual({ type: 'PCT', basisPoints: 400, includesVat: true });
    const updated = (await eventsOf('developmentId', dev.id)).filter(
      (e) => e.type === 'developments.development.updated',
    );
    expect(updated.at(-1)?.payload.changed).toEqual(['commission']);

    await as(owner, (ctx) => developments.deleteDevelopment(ctx, dev.id, changed.version));
    expect(await refusal(as(allowed, (ctx) => developments.getDevelopment(ctx, dev.id)))).toBe('DEVELOPMENT_NOT_FOUND');
  });

  it('[S5-F1] changing access, commission or approving a price list writes an audit entry with before and after', async () => {
    const dev = await createDev();
    const auditOf = (targetId: string) =>
      rows<{ type: string; agency_id: string; actor_user_id: string; metadata: Record<string, unknown> }>(
        sql`select type, agency_id, actor_user_id, metadata from audit_logs where target_id = ${targetId} order by id`,
      );

    const shared = await as(owner, (ctx) =>
      developments.setDevelopmentAccess(ctx, dev.id, {
        version: dev.version,
        kind: 'PRIVATE_NETWORK',
        allowedAgencyIds: [allowed.agencyId],
      }),
    );
    const opened = await as(owner, (ctx) =>
      developments.setDevelopmentAccess(ctx, dev.id, {
        version: shared.version,
        kind: 'OPEN',
        allowedAgencyIds: [stranger.agencyId],
      }),
    );
    const changed = await as(owner, (ctx) =>
      developments.updateDevelopment(ctx, dev.id, {
        version: opened.version,
        commission: { type: 'FIXED', amount: { amountCents: 1_500_000, currency: 'EUR' }, includesVat: true },
      }),
    );
    // A change that leaves the commission alone writes no commission entry.
    await as(owner, (ctx) =>
      developments.updateDevelopment(ctx, dev.id, { version: changed.version, name: 'Renamed' }),
    );
    expect(await auditOf(dev.id)).toEqual([
      {
        type: 'developments.development.accessChanged',
        agency_id: owner.agencyId,
        actor_user_id: owner.userId,
        metadata: {
          kindBefore: 'PRIVATE_NETWORK',
          kindAfter: 'PRIVATE_NETWORK',
          allowedBefore: 0,
          allowedAfter: 1,
          added: [allowed.agencyId],
          removed: [],
          truncated: false,
        },
      },
      {
        type: 'developments.development.accessChanged',
        agency_id: owner.agencyId,
        actor_user_id: owner.userId,
        metadata: {
          kindBefore: 'PRIVATE_NETWORK',
          kindAfter: 'OPEN',
          allowedBefore: 1,
          allowedAfter: 1,
          added: [stranger.agencyId],
          removed: [allowed.agencyId],
          truncated: false,
        },
      },
      {
        type: 'developments.development.commissionChanged',
        agency_id: owner.agencyId,
        actor_user_id: owner.userId,
        metadata: { before: 'PCT 500bp', after: 'FIXED 1500000 EUR +VAT' },
      },
    ]);

    // A unit's commission, one unit and many.
    const [u1, u2] = await addUnits(dev, [unit('U1', 10_000_000), unit('U2', 11_000_000)]);
    if (!u1 || !u2) throw new Error('units not created');
    await as(owner, (ctx) =>
      developments.updateUnit(
        ctx,
        dev.id,
        u1.id,
        UpdateUnitBody.parse({
          version: u1.version,
          commission: { type: 'PCT', basisPoints: 300, includesVat: false },
        }),
      ),
    );
    expect((await auditOf(u1.id)).map((a) => [a.type, a.metadata])).toEqual([
      [
        'developments.unit.commissionChanged',
        { developmentId: dev.id, units: 1, unitIds: [u1.id], before: ['none'], after: 'PCT 300bp', truncated: false },
      ],
    ]);
    await as(owner, (ctx) =>
      developments.bulkUpdateUnits(
        ctx,
        dev.id,
        BulkUpdateUnitsBody.parse({ unitIds: [u1.id, u2.id], patch: { commission: null } }),
      ),
    );
    const bulk = await rows<{ target_id: string | null; metadata: Record<string, unknown> }>(
      sql`select target_id, metadata from audit_logs
           where type = 'developments.unit.commissionChanged' and metadata->>'developmentId' = ${dev.id} order by id`,
    );
    expect(bulk[1]).toEqual({
      target_id: u1.id, // only U1 had a commission to remove
      metadata: {
        developmentId: dev.id,
        units: 1,
        unitIds: [u1.id],
        before: ['PCT 300bp'],
        after: null,
        truncated: false,
      },
    });

    // Approving a price list: the version, what changed from what to what.
    const list = await as(owner, (ctx) =>
      developments.createPriceList(
        ctx,
        dev.id,
        CreatePriceListBody.parse({
          effectiveFrom: '2026-11-01',
          entries: [
            { ref: 'U1', priceCents: 12_000_000 },
            { ref: 'U2', priceCents: 11_000_000, status: 'SOLD' },
          ],
        }),
      ),
    );
    await as(owner, (ctx) => developments.approvePriceList(ctx, dev.id, list.version));
    expect((await auditOf(list.id)).map((a) => [a.type, a.actor_user_id, a.metadata])).toEqual([
      [
        'developments.priceList.approved',
        owner.userId,
        {
          developmentId: dev.id,
          version: list.version,
          unitsChanged: 2,
          pricesChanged: 1,
          statusesChanged: 1,
          lastVerifiedBefore: null,
          changes: ['U1 price 10000000→12000000', 'U2 status AVAILABLE→SOLD'],
          truncated: false,
        },
      ],
    ]);
  });

  it('[S5-F1] unknown, unlisted or suspended allowed agencies are refused with one neutral error', async () => {
    const [pending, suspended] = await Promise.all([createFounder(), createFounder()]);
    await setAgencyStatus(suspended.agencyId, 'VERIFIED');
    await setAgencyStatus(suspended.agencyId, 'SUSPENDED');
    const dev = await createDev();
    const share = (allowedAgencyIds: string[]) =>
      as(owner, (ctx) =>
        developments.setDevelopmentAccess(ctx, dev.id, {
          version: dev.version,
          kind: 'PRIVATE_NETWORK',
          allowedAgencyIds,
        }),
      );
    const answers = await Promise.all(
      [newId(), pending.agencyId, suspended.agencyId].map((id) =>
        share([allowed.agencyId, id]).then(
          () => 'resolved',
          (err: { code?: string; details?: unknown }) => [err.code, err.details],
        ),
      ),
    );
    const neutral = ['VALIDATION_FAILED', { field: 'allowedAgencyIds', reason: 'unknown' }];
    expect(answers).toEqual([neutral, neutral, neutral]);
    expect((await share([allowed.agencyId])).access?.allowedAgencyIds).toEqual([allowed.agencyId]);
  });

  it('[S5-F1] an approval of many long non-Latin unit refs stays within the audit metadata cap', async () => {
    const dev = await createDev();
    const ref = (i: number) => `${'ж'.repeat(37)}${String(i).padStart(3, '0')}`; // 40 characters, 114 bytes
    await addUnits(
      dev,
      Array.from({ length: 25 }, (_, i) => unit(ref(i), 10_000_000)),
    );
    const list = await as(owner, (ctx) =>
      developments.createPriceList(
        ctx,
        dev.id,
        CreatePriceListBody.parse({
          effectiveFrom: '2026-11-01',
          entries: Array.from({ length: 25 }, (_, i) => ({ ref: ref(i), priceCents: 20_000_000, status: 'RESERVED' })),
        }),
      ),
    );
    await as(owner, (ctx) => developments.approvePriceList(ctx, dev.id, list.version));
    const [entry] = await rows<{ metadata: { unitsChanged: number; changes: string[]; truncated: boolean } }>(
      sql`select metadata from audit_logs where target_id = ${list.id}`,
    );
    expect(entry?.metadata.unitsChanged).toBe(25);
    expect(entry?.metadata.truncated).toBe(true);
    expect(entry?.metadata.changes.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(entry?.metadata))).toBeLessThanOrEqual(4096);
  });

  it('[S5-F3] approving a 2,000-unit price list stays within the dashboard budget', async () => {
    const dev = await createDev();
    const ref = (i: number) => `R${String(i).padStart(4, '0')}`;
    for (let b = 0; b < 4; b++) {
      await addUnits(
        dev,
        Array.from({ length: 500 }, (_, i) => unit(ref(b * 500 + i), 20_000_000)),
      );
    }
    const list = await as(owner, (ctx) =>
      developments.createPriceList(
        ctx,
        dev.id,
        CreatePriceListBody.parse({
          effectiveFrom: '2026-11-01',
          entries: Array.from({ length: 2_000 }, (_, i) => ({
            ref: ref(i),
            priceCents: 21_000_000 + i,
            ...(i % 2 === 0 ? { status: 'RESERVED' as const } : {}),
          })),
        }),
      ),
    );
    let approved: { diff: { changed: unknown[] } } | undefined;
    const started = performance.now();
    const queries = await as(owner, (ctx) =>
      countQueries(async () => {
        approved = await developments.approvePriceList(ctx, dev.id, list.version);
      }),
    );
    const ms = performance.now() - started;
    expect(approved?.diff.changed).toHaveLength(2_000);
    // Dashboard budget: ≤ 10 statements whatever the size (no per-unit events; no statement near 65,535 parameters)
    expect(queries).toBeLessThanOrEqual(10);
    // Budget p95 < 300 ms, measured on staging (H4): on the local Docker Desktop disk one approval takes 390–850 ms
    // (the same statements vary 2–3× run to run). This guards the shape — the old path wrote 6,000 outbox rows.
    expect(ms).toBeLessThan(2_000);
    const unitEvents = await rows<{ n: number }>(sql`select count(*)::int as n from outbox_events
      where payload->>'developmentId' = ${dev.id} and type in
        ('developments.unit.updated', 'developments.unit.priceChanged', 'developments.unit.statusChanged')`);
    expect(unitEvents[0]?.n).toBe(0);
    const approvedEvents = await rows<{ n: number }>(sql`select count(*)::int as n from outbox_events
      where type = 'developments.priceList.approved' and payload->>'priceListId' = ${list.id}`);
    expect(approvedEvents[0]?.n).toBe(1);
    const history = await rows<{ prices: number; statuses: number }>(sql`select
      (select count(*)::int from unit_price_histories where price_list_id = ${list.id}) as prices,
      (select count(*)::int from unit_status_histories where price_list_id = ${list.id}) as statuses`);
    expect(history[0]).toEqual({ prices: 2_000, statuses: 1_000 });
    const units = (await as(owner, (ctx) => developments.listUnits(ctx, dev.id, { limit: 2 }))).items;
    expect(units.map((u) => [u.ref, u.price?.amountCents, u.status])).toEqual([
      ['R0000', 21_000_000, 'RESERVED'],
      ['R0001', 21_000_001, 'AVAILABLE'],
    ]);
  }, 120_000);

  it('[S5-F3] no list repo in developments selects every column; one price list is read without its lines', async () => {
    const { listColumns } = await import('../repo');
    expect(listColumns.developments).not.toContain('deletedAt');
    expect(listColumns.developments).not.toContain('legacyId');
    expect(listColumns.units).not.toContain('agencyId');
    expect(listColumns.units).not.toContain('createdAt');
    // The lists still fill every DTO field; one version carries its diff, not its lines.
    const dev = await createDev();
    await addUnits(dev, [unit('L1', 1_000)]);
    const [listed] = (await as(owner, (ctx) => developments.listUnits(ctx, dev.id, { limit: 1 }))).items;
    expect(listed).toMatchObject({ ref: 'L1', developmentId: dev.id, price: { amountCents: 1_000 } });
    const own = await as(owner, (ctx) => developments.listDevelopments(ctx, { limit: 100 }));
    expect(own.items.find((d) => d.id === dev.id)).toMatchObject({ ref: dev.ref, currency: dev.currency });
    const list = await as(owner, (ctx) =>
      developments.createPriceList(
        ctx,
        dev.id,
        CreatePriceListBody.parse({ effectiveFrom: '2026-11-01', entries: [{ ref: 'L1', priceCents: 2_000 }] }),
      ),
    );
    const one = await as(owner, (ctx) => developments.getPriceList(ctx, dev.id, list.version));
    expect(one.diff.changed).toHaveLength(1);
    expect(one).not.toHaveProperty('entries');
  });

  it('[S5-F3] a new development takes the agency currency unless it names one', async () => {
    const f = await createFounder();
    await setAgencyStatus(f.agencyId, 'VERIFIED');
    const current = await as(f, (ctx) => agencies.getMyAgencySettings(ctx));
    expect(current.currency).toBe('EUR');
    const { updatedAt: _u, version, ...fields } = current;
    await as(f, (ctx) => agencies.updateAgencySettings(ctx, { ...fields, version, currency: 'GBP' }));
    expect((await createDev(f)).currency).toBe('GBP');
    expect((await createDev(f, { currency: 'USD' })).currency).toBe('USD');
    // A settings save without a currency keeps it.
    const saved = await as(f, (ctx) => agencies.getMyAgencySettings(ctx));
    const { updatedAt: _u2, currency: _c, version: v2, ...rest } = saved;
    const kept = await as(f, (ctx) =>
      agencies.updateAgencySettings(ctx, { ...rest, version: v2, registrationValidityDays: 90 }),
    );
    expect(kept.currency).toBe('GBP');
  });

  it('[S5-F3] a development with an approved price list can be deleted for good (purge)', async () => {
    const dev = await createDev();
    await addUnits(dev, [unit('P1', 1_000)]);
    const list = await as(owner, (ctx) =>
      developments.createPriceList(
        ctx,
        dev.id,
        CreatePriceListBody.parse({ effectiveFrom: '2026-11-01', entries: [{ ref: 'P1', priceCents: 2_000 }] }),
      ),
    );
    await as(owner, (ctx) => developments.approvePriceList(ctx, dev.id, list.version));
    await rows(sql`delete from developments where id = ${dev.id}`);
    expect(await rows(sql`select id from price_lists where id = ${list.id}`)).toEqual([]);
    expect(await rows(sql`select id from unit_price_histories where price_list_id = ${list.id}`)).toEqual([]);
  });
});
