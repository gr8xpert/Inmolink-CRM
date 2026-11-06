import { CLIENT_PROFILE_LIMITS, type CreateClientProfileBody, CreateContactBody } from '@inmolink/contracts';
import { closeDb, countQueries, type Tx, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { FALLBACK_CONTENT_LOCALE } from '@inmolink/i18n';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder, impersonatedCtx } from '../../../testing/factories';
import * as crm from '../../crm';
import * as taxonomy from '../../taxonomy';
import * as matching from '../index';

/**
 * Client profiles (R2-02a) on the real test database: CRUD with the version, the owning contact's rule (other agency,
 * partner, Client Mode, impersonating staff refused), `matching.clientProfiles.changed` in the write's transaction,
 * criteria validated like saved searches (taxonomy ids exist, ranges ordered), the per-contact cap, and the contact
 * reactions — a merge moves the profiles to the survivor, an erasure deletes them with their vectors.
 */

const RUN = newId().slice(-8).toLowerCase();
const code = (s: string) => `${s}-cp-${RUN}`;
const L = FALLBACK_CONTENT_LOCALE;
const system = <T>(fn: (tx: Tx) => Promise<T>) => withSystem('matching.clientProfiles.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

let a: Founder;
let b: Founder;
let partner: Founder;
let ids: { city: string; type: string; pool: string };

const as = <T>(f: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: f.userId, agencyId: f.agencyId, requestId: newId(), locale: 'en' }, fn);

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    if (err instanceof ZodError) return 'ZOD';
    throw err;
  }
  return 'accepted';
}

async function member(agencyId: string, role: string): Promise<Founder> {
  const userId = newId();
  const email = `cp-${role.toLowerCase()}-${userId}@example.com`;
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${userId}, ${email}, 'x', ${role}, 'en', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${agencyId}, ${userId}, ${role}, ${role}, ${email})`);
  });
  return { userId, agencyId, email, password: 'x' };
}

const contact = async (f: Founder = a, name = 'Client') =>
  as(
    f,
    async (ctx) =>
      (await crm.createContact(ctx, CreateContactBody.parse({ firstName: `${name} ${newId().slice(-6)}` }))).contact,
  );

const body = (extra: Partial<CreateClientProfileBody> = {}): CreateClientProfileBody => ({
  mode: 'REVIEW',
  frequency: 'DAILY',
  transactionType: 'SALE',
  propertyTypeIds: [ids.type],
  locationIds: [ids.city],
  featureIds: [ids.pool],
  priceMaxCents: 60_000_000,
  bedsMin: 3,
  wishes: '  Sea view, walk to the beach  ',
  ...extra,
});

const changedEvents = (profileId: string) =>
  rows<{ n: number }>(sql`select count(*)::int as n from outbox_events
    where type = 'matching.clientProfiles.changed' and payload->'profileIds' ? ${profileId}`).then((r) => r[0]?.n ?? 0);

beforeAll(async () => {
  await setupTestDb('worker');
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  partner = await member(a.agencyId, 'PARTNER');
  ids = await system(async (tx) => {
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('c'),
      translations: [{ locale: L, name: `Profiland ${RUN}`, slug: code('profiland') }],
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('r'),
      translations: [{ locale: L, name: `Wantshire ${RUN}`, slug: code('wantshire') }],
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('ci'),
      translations: [{ locale: L, name: `Wishton ${RUN}`, slug: code('wishton') }],
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('houses'),
      sort: 0,
      translations: [{ locale: L, name: `Houses ${RUN}`, slug: code('houses') }],
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('villa'),
      sort: 0,
      translations: [{ locale: L, name: `Villa ${RUN}`, slug: code('villa') }],
    });
    const featureGroup = await taxonomy.createFeatureGroup(tx, {
      key: code('outdoor'),
      sort: 0,
      translations: [{ locale: L, name: `Outdoor ${RUN}`, slug: code('outdoor') }],
    });
    const pool = await taxonomy.createFeature(tx, {
      groupId: featureGroup,
      key: code('pool'),
      sort: 0,
      icon: 'pool',
      translations: [{ locale: L, name: `Pool ${RUN}`, slug: code('pool') }],
    });
    return { city, type, pool };
  });
});

afterAll(async () => {
  await closeDb();
});

describe('client profiles (R2-02a)', () => {
  it('[R2-02a] create, get, list (cursor), update at the version, delete', async () => {
    const c = await contact();
    const created = await as(a, (ctx) => matching.createClientProfile(ctx, c.id, body()));
    expect(created).toMatchObject({
      contactId: c.id,
      mode: 'REVIEW',
      transactionType: 'SALE',
      propertyTypeIds: [ids.type],
      priceMaxCents: 60_000_000,
      bedsMin: 3,
      wishes: 'Sea view, walk to the beach',
      version: 1,
    });
    expect(await as(a, (ctx) => matching.getClientProfile(ctx, created.id))).toEqual(created);

    const second = await as(a, (ctx) => matching.createClientProfile(ctx, c.id, body({ wishes: null })));
    const third = await as(a, (ctx) => matching.createClientProfile(ctx, c.id, { mode: 'OFF' }));
    expect(third).toMatchObject({ mode: 'OFF', frequency: 'DAILY', propertyTypeIds: [], wishes: null });
    const page1 = await as(a, (ctx) => matching.listClientProfiles(ctx, c.id, { limit: 2 }));
    expect(page1.items.map((p) => p.id)).toEqual([created.id, second.id]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await as(a, (ctx) =>
      matching.listClientProfiles(ctx, c.id, { limit: 2, cursor: page1.nextCursor ?? undefined }),
    );
    expect(page2).toEqual({ items: [third], nextCursor: null });
    // the contact check and the page: two statements
    expect(await as(a, (ctx) => countQueries(() => matching.listClientProfiles(ctx, c.id, { limit: 100 })))).toBe(2);

    const updated = await as(a, (ctx) =>
      matching.updateClientProfile(ctx, created.id, { ...body({ mode: 'AUTO_SEND', bedsMin: 4 }), version: 1 }),
    );
    expect(updated).toMatchObject({ mode: 'AUTO_SEND', bedsMin: 4, version: 2 });
    // a stale version is refused, nothing changes
    expect(
      await refusal(as(a, (ctx) => matching.updateClientProfile(ctx, created.id, { ...body(), version: 1 }))),
    ).toBe('VERSION_CONFLICT');
    expect((await as(a, (ctx) => matching.getClientProfile(ctx, created.id))).version).toBe(2);

    await as(a, (ctx) => matching.deleteClientProfile(ctx, created.id));
    expect(await refusal(as(a, (ctx) => matching.getClientProfile(ctx, created.id)))).toBe('CLIENT_PROFILE_NOT_FOUND');
    expect(await refusal(as(a, (ctx) => matching.deleteClientProfile(ctx, created.id)))).toBe(
      'CLIENT_PROFILE_NOT_FOUND',
    );
  });

  it('[R2-02a] every write emits matching.clientProfiles.changed in its transaction (a rollback leaves neither)', async () => {
    const c = await contact();
    const p = await as(a, (ctx) => matching.createClientProfile(ctx, c.id, body()));
    expect(await changedEvents(p.id)).toBe(1);
    await as(a, (ctx) => matching.updateClientProfile(ctx, p.id, { ...body({ mode: 'OFF' }), version: 1 }));
    expect(await changedEvents(p.id)).toBe(2);
    await as(a, (ctx) => matching.deleteClientProfile(ctx, p.id));
    expect(await changedEvents(p.id)).toBe(3);

    let rolledBack = '';
    await expect(
      as(a, async (ctx) => {
        rolledBack = (await matching.createClientProfile(ctx, c.id, body())).id;
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(rolledBack).not.toBe('');
    expect(await changedEvents(rolledBack)).toBe(0);
    expect(await rows(sql`select 1 from client_profiles where id = ${rolledBack}`)).toEqual([]);
  });

  it('[R2-02a] the owning contact’s rule: another agency, a partner, Client Mode and impersonating staff are refused', async () => {
    const c = await contact();
    const p = await as(a, (ctx) => matching.createClientProfile(ctx, c.id, body()));
    // another agency: neither the contact nor the profile exists for it
    expect(await refusal(as(b, (ctx) => matching.createClientProfile(ctx, c.id, body())))).toBe('CONTACT_NOT_FOUND');
    expect(await refusal(as(b, (ctx) => matching.listClientProfiles(ctx, c.id, { limit: 25 })))).toBe(
      'CONTACT_NOT_FOUND',
    );
    expect(await refusal(as(b, (ctx) => matching.getClientProfile(ctx, p.id)))).toBe('CLIENT_PROFILE_NOT_FOUND');
    expect(
      await refusal(as(b, (ctx) => matching.updateClientProfile(ctx, p.id, { ...body({ mode: 'OFF' }), version: 1 }))),
    ).toBe('CLIENT_PROFILE_NOT_FOUND');
    expect(await refusal(as(b, (ctx) => matching.deleteClientProfile(ctx, p.id)))).toBe('CLIENT_PROFILE_NOT_FOUND');
    // under b's RLS the row is not even visible
    expect(
      await as(b, async (ctx) => (await ctx.tx.execute(sql`select 1 from client_profiles where id = ${p.id}`)).rows),
    ).toEqual([]);
    // a partner membership may not read or write contacts, so neither their profiles
    expect(await refusal(as(partner, (ctx) => matching.getClientProfile(ctx, p.id)))).toBe('FORBIDDEN');
    expect(await refusal(as(partner, (ctx) => matching.createClientProfile(ctx, c.id, body())))).toBe('FORBIDDEN');
    // Client Mode and staff impersonating the member: nothing
    expect(await refusal(as(a, (ctx) => matching.getClientProfile({ ...ctx, clientMode: true }, p.id)))).toBe(
      'FORBIDDEN',
    );
    expect(
      await refusal(as(a, async (ctx) => matching.getClientProfile(await impersonatedCtx(ctx, newId()), p.id))),
    ).toBe('FORBIDDEN');
    expect((await as(a, (ctx) => matching.getClientProfile(ctx, p.id))).version).toBe(1);
  });

  it('[R2-02a] criteria are validated like saved searches: taxonomy ids exist, ranges ordered, wishes bounded', async () => {
    const c = await contact();
    const unknown = newId();
    for (const field of ['locationIds', 'propertyTypeIds', 'featureIds'] as const) {
      const err = await as(a, (ctx) => matching.createClientProfile(ctx, c.id, body({ [field]: [unknown] }))).catch(
        (e: unknown) => e,
      );
      expect(isAppError(err) && err.code === 'VALIDATION_FAILED' && err.details).toEqual({ field, reason: 'unknown' });
    }
    expect(
      await refusal(
        as(a, (ctx) => matching.createClientProfile(ctx, c.id, body({ priceMinCents: 2, priceMaxCents: 1 }))),
      ),
    ).toBe('ZOD');
    expect(
      await refusal(as(a, (ctx) => matching.createClientProfile(ctx, c.id, body({ areaMinM2: 200, areaMaxM2: 100 })))),
    ).toBe('ZOD');
    expect(await refusal(as(a, (ctx) => matching.createClientProfile(ctx, c.id, body({ bedsMin: -1 }))))).toBe('ZOD');
    expect(
      await refusal(
        as(a, (ctx) =>
          matching.createClientProfile(ctx, c.id, body({ wishes: 'x'.repeat(CLIENT_PROFILE_LIMITS.wishesChars + 1) })),
        ),
      ),
    ).toBe('ZOD');
    expect(
      await refusal(as(a, (ctx) => matching.createClientProfile(ctx, c.id, body({ wishes: 'quiet‮street' })))),
    ).toBe('ZOD');
    expect(
      await refusal(
        as(a, (ctx) =>
          matching.createClientProfile(ctx, c.id, { ...body(), mode: 'LOUD' } as unknown as CreateClientProfileBody),
        ),
      ),
    ).toBe('ZOD');
    // line breaks in wishes are fine; duplicates in the id lists collapse
    const ok = await as(a, (ctx) =>
      matching.createClientProfile(
        ctx,
        c.id,
        body({ wishes: 'sea view\nquiet street', featureIds: [ids.pool, ids.pool] }),
      ),
    );
    expect(ok).toMatchObject({ wishes: 'sea view\nquiet street', featureIds: [ids.pool] });
    expect(await rows(sql`select 1 from client_profiles where contact_id = ${c.id}`)).toHaveLength(1);
  });

  it('[R2-02a] at most perContact profiles per contact; a closed (merged) contact takes none', async () => {
    const c = await contact();
    for (let i = 0; i < CLIENT_PROFILE_LIMITS.perContact; i += 1) {
      await as(a, (ctx) => matching.createClientProfile(ctx, c.id, { mode: 'OFF' }));
    }
    const err = await as(a, (ctx) => matching.createClientProfile(ctx, c.id, { mode: 'OFF' })).catch((e: unknown) => e);
    expect(isAppError(err) && err.code).toBe('CLIENT_PROFILE_LIMIT');
    expect(await refusal(as(a, (ctx) => matching.createClientProfile(ctx, newId(), body())))).toBe('CONTACT_NOT_FOUND');
  });

  it('[R2-02a] parallel creates for one contact still stop at perContact (the contact lock serializes them)', async () => {
    const c = await contact();
    for (let i = 0; i < CLIENT_PROFILE_LIMITS.perContact - 1; i += 1) {
      await as(a, (ctx) => matching.createClientProfile(ctx, c.id, { mode: 'OFF' }));
    }
    const outcomes = await Promise.all(
      [0, 1, 2].map(() => refusal(as(a, (ctx) => matching.createClientProfile(ctx, c.id, { mode: 'OFF' })))),
    );
    expect(outcomes.sort()).toEqual(['CLIENT_PROFILE_LIMIT', 'CLIENT_PROFILE_LIMIT', 'accepted']);
    expect(await rows(sql`select 1 from client_profiles where contact_id = ${c.id}`)).toHaveLength(
      CLIENT_PROFILE_LIMITS.perContact,
    );
  });

  it('[R2-02a] a contact merge moves the closed contact’s profiles to the survivor (event → job, idempotent)', async () => {
    const survivor = await contact(a, 'Keep');
    const dup = await contact(a, 'Dup');
    const kept = await as(a, (ctx) => matching.createClientProfile(ctx, survivor.id, body()));
    const moved = await as(a, (ctx) => matching.createClientProfile(ctx, dup.id, body({ mode: 'AUTO_SEND' })));
    await as(a, (ctx) => crm.mergeContacts(ctx, survivor.id, { duplicateId: dup.id, version: survivor.version }));
    // the closed contact's profile is hidden until the reaction ran, and the closed contact takes no new one
    expect(await refusal(as(a, (ctx) => matching.getClientProfile(ctx, moved.id)))).toBe('CLIENT_PROFILE_NOT_FOUND');
    expect(await refusal(as(a, (ctx) => matching.createClientProfile(ctx, dup.id, body())))).toBe('CONTACT_NOT_FOUND');

    // crm.contact.merged → one matching.repointClientProfiles job (job id from the event)
    const queued: unknown[] = [];
    const spy = vi.spyOn(matching.clientProfileJobs.repointClientProfiles, 'enqueue').mockImplementation(async (p) => {
      queued.push(p);
      return { id: 'test' };
    });
    matching.registerMatchingSubscriptions();
    const eventId = newId();
    try {
      const meta = {
        eventId,
        agencyId: a.agencyId,
        type: 'crm.contact.merged',
        version: 1,
        createdAt: new Date(),
        attempt: 1,
      };
      for (const s of defaultSubscribers.get('crm.contact.merged', 1)) {
        if (s.name === 'matching.clientProfiles.contactMerged') {
          await s.handler({ agencyId: a.agencyId, survivorId: survivor.id, mergedId: dup.id } as never, meta);
        }
      }
    } finally {
      matching.unregisterMatchingSubscriptions();
      spy.mockRestore();
    }
    expect(queued).toEqual([{ eventId, agencyId: a.agencyId, survivorId: survivor.id, mergedId: dup.id }]);

    const job = matching.clientProfileJobs.repointClientProfiles.spec;
    expect(await job.run(queued[0] as never, {} as never)).toEqual({ profiles: 1 });
    expect(await job.run(queued[0] as never, {} as never)).toEqual({ profiles: 0 });
    const list = await as(a, (ctx) => matching.listClientProfiles(ctx, survivor.id, { limit: 25 }));
    expect(list.items.map((p) => p.id).sort()).toEqual([kept.id, moved.id].sort());
    expect(list.items.find((p) => p.id === moved.id)).toMatchObject({ contactId: survivor.id, version: 2 });
    expect(await changedEvents(moved.id)).toBe(2);
  });

  it('[R2-02a] a contact erasure deletes its profiles and their vectors, nobody else’s (event → job)', async () => {
    const target = await contact(a, 'Erase');
    const other = await contact(a, 'Stay');
    const gone = await as(a, (ctx) => matching.createClientProfile(ctx, target.id, body()));
    const gone2 = await as(a, (ctx) => matching.createClientProfile(ctx, target.id, body({ mode: 'OFF' })));
    const stays = await as(a, (ctx) => matching.createClientProfile(ctx, other.id, body()));
    // vectors as the embed job would have written them
    for (const id of [gone.id, stays.id]) {
      await rows(sql`insert into client_profile_embeddings (profile_id, owner_agency_id, embedding, model, content_hash, source_version)
        values (${id}, ${a.agencyId}, array_fill(0.1::real, array[1024])::halfvec(1024), 'm', 'h', 1)`);
    }
    await as(a, (ctx) =>
      crm.eraseContact(ctx, target.id, { version: target.version, confirm: 'ERASE' }, { verifyStepUp: async () => {} }),
    );

    const queued: unknown[] = [];
    const spy = vi.spyOn(matching.clientProfileJobs.eraseContactProfiles, 'enqueue').mockImplementation(async (p) => {
      queued.push(p);
      return { id: 'test' };
    });
    matching.registerMatchingSubscriptions();
    const eventId = newId();
    try {
      const meta = {
        eventId,
        agencyId: a.agencyId,
        type: 'crm.contact.erased',
        version: 1,
        createdAt: new Date(),
        attempt: 1,
      };
      for (const s of defaultSubscribers.get('crm.contact.erased', 1)) {
        if (s.name === 'matching.clientProfiles.contactErased') {
          await s.handler({ agencyId: a.agencyId, contactId: target.id } as never, meta);
        }
      }
    } finally {
      matching.unregisterMatchingSubscriptions();
      spy.mockRestore();
    }
    expect(queued).toEqual([{ eventId, agencyId: a.agencyId, contactId: target.id }]);

    const job = matching.clientProfileJobs.eraseContactProfiles.spec;
    expect(await job.run(queued[0] as never, {} as never)).toEqual({ profiles: 2 });
    expect(await job.run(queued[0] as never, {} as never)).toEqual({ profiles: 0 });
    expect(await rows(sql`select id from client_profiles where id in (${gone.id}, ${gone2.id}, ${stays.id})`)).toEqual([
      { id: stays.id },
    ]);
    expect(
      await rows(sql`select profile_id from client_profile_embeddings where profile_id in (${gone.id}, ${stays.id})`),
    ).toEqual([{ profile_id: stays.id }]);
  });
});
