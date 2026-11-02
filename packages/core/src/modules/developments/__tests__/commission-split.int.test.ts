import { CreateDevelopmentBody, CreateUnitsBody, type DevelopmentDto } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder, impersonatedCtx } from '../../../testing/factories';
import * as taxonomy from '../../taxonomy';
import * as developments from '../index';

/**
 * The per-development commission split (S17-F5): the selling agency's share of a unit's commission, 5000 (50/50) by
 * default, set by the owner agency's admins only, audited, and read by the network with the commission terms.
 */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];

type Member = { userId: string; agencyId: string };
let owner: Founder;
let agent: Member;
let allowed: Founder;
let stranger: Founder;
let staffId: string;
let ids: { location: string; type: string };

const as = <T>(m: Member, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (err: { code?: string }) => err.code ?? String(err),
  );
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('developments.split.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

let seq = 0;
const createDev = (m: Member = owner, body: Partial<CreateDevelopmentBody> = {}) =>
  as(m, (ctx) =>
    developments.createDevelopment(
      ctx,
      CreateDevelopmentBody.parse({
        ref: code(`S${++seq}`),
        name: 'Split Heights',
        locationId: ids.location,
        commission: { type: 'PCT', basisPoints: 400, includesVat: false },
        ...body,
      }),
    ),
  );
const shareWithAllowed = (dev: DevelopmentDto) =>
  as(owner, (ctx) =>
    developments.setDevelopmentAccess(ctx, dev.id, {
      version: dev.version,
      kind: 'PRIVATE_NETWORK',
      allowedAgencyIds: [allowed.agencyId],
    }),
  );

beforeAll(async () => {
  await setupTestDb('worker');
  [owner, allowed, stranger] = await Promise.all([createFounder(), createFounder(), createFounder()]);
  for (const f of [owner, allowed, stranger]) await setAgencyStatus(f.agencyId, 'VERIFIED');
  const agentId = newId();
  staffId = newId();
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${agentId}, ${`split-agent-${agentId}@example.com`}, 'x', 'Agent', 'es', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${owner.agencyId}, ${agentId}, 'AGENT', 'Agent', ${`split-agent-${agentId}@example.com`})`);
  });
  agent = { userId: agentId, agencyId: owner.agencyId };
  ids = await system(async (tx) => {
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('sp'),
      translations: tr(`Splitland ${RUN}`, 'splitland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('sp-flats'),
      sort: 0,
      translations: tr(`Flats ${RUN}`, 'sp-flats'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('sp-apartment'),
      sort: 0,
      translations: tr(`Apartment ${RUN}`, 'sp-apartment'),
    });
    return { location, type };
  });
}, 120_000);

afterAll(closeDb);

describe('development commission split (S17-F5)', () => {
  it('[S17-F5] a new development defaults to a 50/50 split (5000), existing rows too', async () => {
    const dev = await createDev();
    expect(dev.commissionSplitBp).toBe(5000);
    const [row] = await rows<{ commission_split_bp: number }>(
      sql`select commission_split_bp from developments where id = ${dev.id}`,
    );
    expect(row?.commission_split_bp).toBe(5000);
    // The column default is the backfill: a row written without it (an import, a pre-0180 row) holds 5000.
    const [col] = await rows<{ is_nullable: string; column_default: string }>(sql`
      select is_nullable, column_default from information_schema.columns
      where table_name = 'developments' and column_name = 'commission_split_bp'`);
    expect(col).toEqual({ is_nullable: 'NO', column_default: '5000' });
    // An admin may set it when creating.
    expect((await createDev(owner, { commissionSplitBp: 6000 })).commissionSplitBp).toBe(6000);
    // Client Mode never shows it.
    const client = await as(owner, (ctx) => developments.getDevelopment({ ...ctx, clientMode: true }, dev.id));
    expect(client.commissionSplitBp).toBeNull();
  });

  it('[S17-F5] an owner admin changes the split: audited, one event in the same transaction, the network reads it', async () => {
    const dev = await shareWithAllowed(await createDev());
    const [u] = (
      await as(owner, (ctx) =>
        developments.createUnits(
          ctx,
          dev.id,
          CreateUnitsBody.parse({ units: [{ ref: 'A1', propertyTypeId: ids.type, bedrooms: 2, priceCents: 1 }] }),
        ),
      )
    ).items;
    if (!u) throw new Error('unit not created');
    const networkTerms = () =>
      as(allowed, async (ctx) => ({
        unit: (await developments.networkUnitTerms(ctx, [u.id]))[0]?.splitBp,
        development: (await developments.networkDevelopmentTerms(ctx, dev.id))?.splitBp,
      }));
    expect(await networkTerms()).toEqual({ unit: 5000, development: 5000 });

    const changed = await as(owner, (ctx) =>
      developments.updateDevelopment(ctx, dev.id, { version: dev.version, commissionSplitBp: 7000 }),
    );
    expect(changed.commissionSplitBp).toBe(7000);
    expect(await networkTerms()).toEqual({ unit: 7000, development: 7000 });
    // The other agency's network view of the development shows it (agent side).
    expect((await as(allowed, (ctx) => developments.getDevelopment(ctx, dev.id))).commissionSplitBp).toBe(7000);

    const audit = await rows<{ type: string; actor_user_id: string; metadata: unknown; tx: string }>(sql`
      select type, actor_user_id, metadata, xmin::text as tx from audit_logs
      where target_id = ${dev.id} and type = 'developments.development.commissionSplitChanged'`);
    expect(audit.map(({ tx: _tx, ...a }) => a)).toEqual([
      {
        type: 'developments.development.commissionSplitChanged',
        actor_user_id: owner.userId,
        metadata: { before: 5000, after: 7000 },
      },
    ]);
    const events = await rows<{ payload: { changed: string[]; version: number }; tx: string }>(sql`
      select payload, xmin::text as tx from outbox_events
      where type = 'developments.development.updated' and payload->>'developmentId' = ${dev.id}`);
    expect(events.map((e) => e.payload.changed)).toEqual([['commissionSplitBp']]);
    // Written by the same transaction as the audit entry (and so the change).
    expect(events[0]?.tx).toBe(audit[0]?.tx);
    // Setting the same value again is no change: no audit entry.
    await as(owner, (ctx) =>
      developments.updateDevelopment(ctx, dev.id, { version: changed.version, commissionSplitBp: 7000 }),
    );
    const again = await rows<{ n: number }>(sql`select count(*)::int as n from audit_logs
      where target_id = ${dev.id} and type = 'developments.development.commissionSplitChanged'`);
    expect(again[0]?.n).toBe(1);
  });

  it('[S17-F5] only the owner agency admins change the split: its agents, other agencies and staff are refused', async () => {
    const dev = await shareWithAllowed(await createDev());
    const set = (m: Member, bp = 8000, wrap: (ctx: Ctx) => Promise<Ctx> | Ctx = (c) => c) =>
      refusal(
        as(m, async (ctx) =>
          developments.updateDevelopment(await wrap(ctx), dev.id, { version: dev.version, commissionSplitBp: bp }),
        ),
      );
    // A non-admin member of the owner agency (AGENT), the service's policy decides, not the route.
    expect(await set(agent)).toBe('FORBIDDEN');
    expect(await refusal(createDev(agent, { commission: null, commissionSplitBp: 8000 }))).toBe('FORBIDDEN');
    // Another agency that reads the development, and one that cannot see it.
    expect(await set(allowed)).toBe('FORBIDDEN');
    expect(await set(stranger)).toBe('DEVELOPMENT_NOT_FOUND');
    // Staff impersonating the owner admin: the deal is the agency's.
    expect(await set(owner, 8000, (ctx) => impersonatedCtx(ctx, staffId))).toBe('FORBIDDEN');
    // Client Mode is read-only.
    expect(await set(owner, 8000, (ctx) => ({ ...ctx, clientMode: true }))).toBe('FORBIDDEN');
    const [row] = await rows<{ commission_split_bp: number }>(
      sql`select commission_split_bp from developments where id = ${dev.id}`,
    );
    expect(row?.commission_split_bp).toBe(5000);
  });

  it('[S17-F5] creating with the default split needs no admin, like an update that leaves it alone; another split does', async () => {
    // An agent may create a development; naming the default 50/50 changes nothing, so it is not refused.
    const dev = await createDev(agent, { commission: null, commissionSplitBp: 5000 });
    expect(dev.commissionSplitBp).toBe(5000);
    // Any other split is the deal offered to collaborating agencies: the owner's admins only — nothing is written.
    const ref = code('agent-split');
    expect(await refusal(createDev(agent, { ref, commission: null, commissionSplitBp: 4999 }))).toBe('FORBIDDEN');
    const written = await rows<{ n: number }>(
      sql`select count(*)::int as n from developments where agency_id = ${owner.agencyId} and ref = ${ref}`,
    );
    expect(written[0]?.n).toBe(0);
    // The admin path is unchanged: the default or another split.
    expect((await createDev(owner, { commissionSplitBp: 5000 })).commissionSplitBp).toBe(5000);
    expect((await createDev(owner, { commissionSplitBp: 4999 })).commissionSplitBp).toBe(4999);
  });

  it('[S17-F5] a create with a non-default split by staff acting as the admin, or in Client Mode, is refused', async () => {
    const createAs = (wrap: (ctx: Ctx) => Promise<Ctx> | Ctx, ref: string) =>
      refusal(
        as(owner, async (ctx) =>
          developments.createDevelopment(
            await wrap(ctx),
            CreateDevelopmentBody.parse({
              ref,
              name: 'Split Heights',
              locationId: ids.location,
              commissionSplitBp: 8000,
            }),
          ),
        ),
      );
    const refs = [code('imp-split'), code('cm-split')] as const;
    // The deal is the agency's: staff may create a development for it, never set its split.
    expect(await createAs((ctx) => impersonatedCtx(ctx, staffId), refs[0])).toBe('FORBIDDEN');
    // Client Mode is read-only.
    expect(await createAs((ctx) => ({ ...ctx, clientMode: true }), refs[1])).toBe('FORBIDDEN');
    const written = await rows<{ n: number }>(sql`select count(*)::int as n from developments
      where agency_id = ${owner.agencyId} and ref in (${refs[0]}, ${refs[1]})`);
    expect(written[0]?.n).toBe(0);
  });

  it('[S17-F5] an update sending the stored commission or split needs no admin; a changed value does', async () => {
    const dev = await createDev();
    const update = (body: Omit<Parameters<typeof developments.updateDevelopment>[2], 'version'>, version: number) =>
      as(agent, (ctx) => developments.updateDevelopment(ctx, dev.id, { version, ...body }));
    // An agent saves the form with the deal as stored (4 %, no VAT, 50/50) and another field changed: accepted.
    const saved = await update(
      {
        name: 'Split Heights II',
        commission: { type: 'PCT', basisPoints: 400, includesVat: false },
        commissionSplitBp: 5000,
      },
      dev.version,
    );
    expect(saved).toMatchObject({ name: 'Split Heights II', commissionSplitBp: 5000 });
    expect(saved.commission).toMatchObject({ type: 'PCT', basisPoints: 400, includesVat: false });
    // Any change of the deal is the admins': the split, the rate, the VAT flag, or removing it.
    for (const body of [
      { commissionSplitBp: 5001 },
      { commission: { type: 'PCT' as const, basisPoints: 401, includesVat: false } },
      { commission: { type: 'PCT' as const, basisPoints: 400, includesVat: true } },
      { commission: null },
    ]) {
      expect(await refusal(update(body, saved.version)), JSON.stringify(body)).toBe('FORBIDDEN');
    }
    const [row] = await rows<{ commission_bp: number; commission_split_bp: number; audits: number }>(sql`
      select commission_bp, commission_split_bp, (select count(*)::int from audit_logs where target_id = ${dev.id}
        and type in ('developments.development.commissionChanged', 'developments.development.commissionSplitChanged'))
        as audits
      from developments where id = ${dev.id}`);
    expect(row).toEqual({ commission_bp: 400, commission_split_bp: 5000, audits: 0 });
    // The owner's admin still changes it.
    const changed = await as(owner, (ctx) =>
      developments.updateDevelopment(ctx, dev.id, { version: saved.version, commissionSplitBp: 5001 }),
    );
    expect(changed.commissionSplitBp).toBe(5001);
  });

  it('[S17-F5] the development says whether the caller may change the commission and split', async () => {
    const dev = await shareWithAllowed(await createDev());
    const flag = (m: Member, wrap: (ctx: Ctx) => Promise<Ctx> | Ctx = (c) => c) =>
      as(m, async (ctx) => (await developments.getDevelopment(await wrap(ctx), dev.id)).canSetCommission);
    expect(dev.canSetCommission).toBe(true);
    expect(await flag(owner)).toBe(true);
    // The owner agency's agent (shown read-only), another agency, staff acting as the admin, Client Mode: false.
    expect(await flag(agent)).toBe(false);
    expect(await flag(allowed)).toBe(false);
    expect(await flag(owner, (ctx) => impersonatedCtx(ctx, staffId))).toBe(false);
    const client = await as(owner, (ctx) => developments.getDevelopment({ ...ctx, clientMode: true }, dev.id));
    expect(client).toMatchObject({ canSetCommission: false, commission: null, commissionSplitBp: null });
    // The list carries it too.
    const listed = await as(agent, (ctx) => developments.listDevelopments(ctx, { limit: 100 }));
    expect(listed.items.find((d) => d.id === dev.id)?.canSetCommission).toBe(false);
  });
});
