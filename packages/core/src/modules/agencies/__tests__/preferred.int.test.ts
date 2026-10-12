import { MAX_PREFERRED_AGENCIES } from '@inmolink/contracts';
import { closeDb, withSystem, withTenant } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as agencies from '../index';

/** Preferred agencies and the agency directory on the real test database (S1-07). */

beforeAll(async () => {
  await setupTestDb('worker');
}, 120_000); // setupTestDb under a full parallel verify (S1-F1)

afterAll(async () => {
  await closeDb();
});

interface As {
  clientMode?: boolean;
  impersonatedBy?: string;
}

const as = <T>(m: { userId: string; agencyId: string }, fn: (ctx: Ctx) => Promise<T>, over: As = {}) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, (ctx) =>
    fn({
      ...ctx,
      clientMode: over.clientMode ?? false,
      actor:
        ctx.actor.kind === 'user' && over.impersonatedBy
          ? { ...ctx.actor, impersonatedBy: over.impersonatedBy }
          : ctx.actor,
    }),
  );

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? String(err);
  }
  return 'accepted';
}

const setStatus = (agencyId: string, status: 'VERIFIED' | 'SUSPENDED') =>
  withSystem('preferred agencies test: agency status', (tx) =>
    tx.execute(sql`update agencies set status = ${status}, onboarded_at = now() where agency_id = ${agencyId}`),
  );

/** A founder whose agency is VERIFIED (status change through the trigger that fills the directory). */
async function verifiedAgency(companyName: string): Promise<Founder> {
  const f = await createFounder({ companyName });
  await setStatus(f.agencyId, 'VERIFIED');
  return f;
}

/** An AGENT of the founder's agency (S1-02 invites are not under test here). */
async function agentOf(f: Founder): Promise<{ userId: string; agencyId: string }> {
  const userId = newId();
  await withSystem('preferred agencies test: agent', async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale)
                         values (${userId}, ${`agent-${userId}@example.com`}, 'x', 'Agent', 'en')`);
    await tx.execute(sql`insert into agency_members (user_id, agency_id, role, name, email)
                         values (${userId}, ${f.agencyId}, 'AGENT', 'Agent', ${`agent-${userId}@example.com`})`);
  });
  return { userId, agencyId: f.agencyId };
}

const eventsOf = (type: string, agencyId: string) =>
  withSystem('preferred agencies test: read outbox', async (tx) =>
    (
      await tx.execute<{ payload: Record<string, unknown> }>(
        sql`select payload from outbox_events where type = ${type} and agency_id = ${agencyId} order by id`,
      )
    ).rows.map((r) => r.payload),
  );

/** The listing-policy test as the partner's own tenant session: is `owner` among `app_preferring_agencies()`? */
const isPreferredBy = (partner: Founder, owner: Founder) =>
  withTenant({ agencyId: partner.agencyId }, async (tx) =>
    Boolean(
      (
        await tx.execute<{ ok: boolean }>(
          sql`select ${owner.agencyId}::uuid in (select a from app_preferring_agencies() a) as ok`,
        )
      ).rows[0]?.ok,
    ),
  );

const tag = () => newId().slice(-8);

describe('preferred agencies (S1-07)', () => {
  it('[S1-07] an admin of a verified agency adds a verified agency, lists it with its note and edits the note', async () => {
    const owner = await verifiedAgency(`Owner ${tag()} S.L.`);
    const partner = await verifiedAgency(`Partner ${tag()} S.L.`);

    const added = await as(owner, (ctx) =>
      agencies.addPreferredAgency(ctx, { agencyId: partner.agencyId, note: 'Good with Russian buyers' }),
    );
    expect(added).toMatchObject({
      agencyId: partner.agencyId,
      kind: 'AGENCY',
      listed: true,
      note: 'Good with Russian buyers',
    });
    expect(added.name).toMatch(/^Partner /);

    const page = await as(owner, (ctx) => agencies.listPreferredAgencies(ctx, { limit: 25 }));
    expect(page.items).toEqual([added]);
    expect(page.nextCursor).toBeNull();

    const edited = await as(owner, (ctx) =>
      agencies.updatePreferredAgency(ctx, { agencyId: partner.agencyId }, { note: null }),
    );
    expect(edited.note).toBeNull();
    // Note edits are audited by who, never with the text.
    expect(await eventsOf('agencies.preferred.noteUpdated', owner.agencyId)).toEqual([
      {
        agencyId: owner.agencyId,
        preferredAgencyId: partner.agencyId,
        actorUserId: owner.userId,
        impersonatedBy: null,
      },
    ]);
    expect(await eventsOf('agencies.preferred.added', owner.agencyId)).toEqual([
      {
        agencyId: owner.agencyId,
        preferredAgencyId: partner.agencyId,
        actorUserId: owner.userId,
        impersonatedBy: null,
      },
    ]);
    expect(await isPreferredBy(partner, owner)).toBe(true);
    expect(await isPreferredBy(owner, partner)).toBe(false); // not mutual
  });

  it('[S1-07] only verified agencies can be added — never the agency itself, never twice', async () => {
    const owner = await verifiedAgency(`Owner ${tag()} S.L.`);
    const pending = await createFounder({ companyName: `Pending ${tag()} S.L.` });
    const suspended = await verifiedAgency(`Suspended ${tag()} S.L.`);
    await setStatus(suspended.agencyId, 'SUSPENDED');
    const partner = await verifiedAgency(`Partner ${tag()} S.L.`);
    const add = (agencyId: string) => as(owner, (ctx) => agencies.addPreferredAgency(ctx, { agencyId }));

    expect(await refusal(add(owner.agencyId))).toBe('PREFERRED_AGENCY_INVALID');
    expect(await refusal(add(pending.agencyId))).toBe('PREFERRED_AGENCY_INVALID');
    expect(await refusal(add(suspended.agencyId))).toBe('PREFERRED_AGENCY_INVALID');
    expect(await refusal(add(newId()))).toBe('PREFERRED_AGENCY_INVALID');
    await add(partner.agencyId);
    expect(await refusal(add(partner.agencyId))).toBe('PREFERRED_AGENCY_EXISTS');

    // An agency that is not verified itself takes no part in the network.
    expect(await refusal(as(pending, (ctx) => agencies.addPreferredAgency(ctx, { agencyId: partner.agencyId })))).toBe(
      'VERIFICATION_REQUIRED',
    );
  });

  it('[S1-07] admins manage the list; agents only read it; Client Mode sees nothing; staff impersonating may remove, not add', async () => {
    const owner = await verifiedAgency(`Owner ${tag()} S.L.`);
    const partner = await verifiedAgency(`Partner ${tag()} S.L.`);
    const other = await verifiedAgency(`Other ${tag()} S.L.`);
    const agent = await agentOf(owner);
    const staffId = newId();
    await as(owner, (ctx) => agencies.addPreferredAgency(ctx, { agencyId: partner.agencyId, note: 'internal' }));

    expect(await refusal(as(agent, (ctx) => agencies.addPreferredAgency(ctx, { agencyId: other.agencyId })))).toBe(
      'FORBIDDEN',
    );
    expect(await refusal(as(agent, (ctx) => agencies.removePreferredAgency(ctx, { agencyId: partner.agencyId })))).toBe(
      'FORBIDDEN',
    );
    expect((await as(agent, (ctx) => agencies.listPreferredAgencies(ctx, { limit: 25 }))).items).toHaveLength(1);
    expect(
      await refusal(as(owner, (ctx) => agencies.listPreferredAgencies(ctx, { limit: 25 }), { clientMode: true })),
    ).toBe('FORBIDDEN');
    expect(
      await refusal(
        as(owner, (ctx) => agencies.addPreferredAgency(ctx, { agencyId: other.agencyId }), { impersonatedBy: staffId }),
      ),
    ).toBe('FORBIDDEN');

    await as(owner, (ctx) => agencies.removePreferredAgency(ctx, { agencyId: partner.agencyId }), {
      impersonatedBy: staffId,
    });
    expect(await eventsOf('agencies.preferred.removed', owner.agencyId)).toEqual([
      {
        agencyId: owner.agencyId,
        preferredAgencyId: partner.agencyId,
        actorUserId: owner.userId,
        impersonatedBy: staffId,
      },
    ]);
    expect(await refusal(as(owner, (ctx) => agencies.removePreferredAgency(ctx, { agencyId: partner.agencyId })))).toBe(
      'NOT_FOUND',
    );
  });

  it('[S1-07] removing an agency from the list revokes access on the next query', async () => {
    const owner = await verifiedAgency(`Owner ${tag()} S.L.`);
    const partner = await verifiedAgency(`Partner ${tag()} S.L.`);
    await as(owner, (ctx) => agencies.addPreferredAgency(ctx, { agencyId: partner.agencyId }));
    expect(await isPreferredBy(partner, owner)).toBe(true);
    await as(owner, (ctx) => agencies.removePreferredAgency(ctx, { agencyId: partner.agencyId }));
    expect(await isPreferredBy(partner, owner)).toBe(false);
  });

  it('[S1-07] a partner that stops being verified stops receiving PREFERRED shares and shows as unlisted', async () => {
    const owner = await verifiedAgency(`Owner ${tag()} S.L.`);
    const partner = await verifiedAgency(`Partner ${tag()} S.L.`);
    await as(owner, (ctx) => agencies.addPreferredAgency(ctx, { agencyId: partner.agencyId }));
    await setStatus(partner.agencyId, 'SUSPENDED');
    expect(await isPreferredBy(partner, owner)).toBe(false);
    const [item] = (await as(owner, (ctx) => agencies.listPreferredAgencies(ctx, { limit: 25 }))).items;
    expect(item).toMatchObject({ agencyId: partner.agencyId, listed: false, kind: null });
    expect(item?.name).toMatch(/^Partner /); // the name when added
    // The owner suspended: nobody receives its PREFERRED shares, even with the relationship in place.
    await setStatus(partner.agencyId, 'VERIFIED');
    expect(await isPreferredBy(partner, owner)).toBe(true);
    await setStatus(owner.agencyId, 'SUSPENDED');
    expect(await isPreferredBy(partner, owner)).toBe(false);
  });

  it('[S1-07] the list is capped, and concurrent adds cannot pass the cap', async () => {
    const owner = await verifiedAgency(`Owner ${tag()} S.L.`);
    const a = await verifiedAgency(`Race A ${tag()} S.L.`);
    const b = await verifiedAgency(`Race B ${tag()} S.L.`);
    // Fill the list up to one below the cap directly (workers' role: no guard).
    await withSystem('preferred agencies test: fill the list', async (tx) => {
      await tx.execute(sql`
        with filler as (
          insert into agencies (agency_id, kind, status, name)
          select gen_random_uuid(), 'AGENCY', 'VERIFIED', 'Filler ' || g
            from generate_series(1, ${MAX_PREFERRED_AGENCIES - 1}) g
          returning agency_id)
        insert into preferred_agencies (agency_id, preferred_agency_id)
        select ${owner.agencyId}::uuid, agency_id from filler`);
    });
    const results = await Promise.all(
      [a, b].map((p) => refusal(as(owner, (ctx) => agencies.addPreferredAgency(ctx, { agencyId: p.agencyId })))),
    );
    expect(results.sort()).toEqual(['PREFERRED_AGENCY_LIMIT_REACHED', 'accepted']);
    const page = await as(owner, (ctx) => agencies.listPreferredAgencies(ctx, { limit: 100 }));
    expect(page.items).toHaveLength(100);
    expect(page.nextCursor).not.toBeNull();

    // A direct table write by the same admin cannot pass the cap either (guard trigger 0022).
    const c = await verifiedAgency(`Race C ${tag()} S.L.`);
    expect(
      await refusal(
        withTenant({ agencyId: owner.agencyId, userId: owner.userId }, (tx) =>
          tx.execute(
            sql`insert into preferred_agencies (agency_id, preferred_agency_id) values (${owner.agencyId}, ${c.agencyId})`,
          ),
        ),
      ),
    ).toBe('42501');
  });
});

describe('agency directory (S1-07)', () => {
  it('[S1-07] the directory follows a rename or kind change of a verified agency (staff or system)', async () => {
    const t = tag();
    const owner = await verifiedAgency(`Searcher ${t} S.L.`);
    const renamed = await verifiedAgency(`Before ${t} S.L.`);
    await withSystem('preferred agencies test: rename', (tx) =>
      tx.execute(
        sql`update agencies set name = ${`After ${t} S.L.`}, kind = 'DEVELOPER' where agency_id = ${renamed.agencyId}`,
      ),
    );
    const search = (q: string) => as(owner, (ctx) => agencies.searchAgencyDirectory(ctx, { q }));
    expect((await search(`Before ${t}`)).items).toEqual([]);
    expect((await search(`After ${t}`)).items).toEqual([
      { agencyId: renamed.agencyId, name: `After ${t} S.L.`, kind: 'DEVELOPER', preferred: false },
    ]);
  });

  it('[S1-07] verified agencies find other verified agencies by part of the name — name and kind only', async () => {
    const t = tag();
    const owner = await verifiedAgency(`Searcher ${t} S.L.`);
    const match = await verifiedAgency(`Inmobiliaria Sol_${t} S.L.`);
    const pending = await createFounder({ companyName: `Sol_${t} Pending S.L.` });
    const suspended = await verifiedAgency(`Sol_${t} Suspended S.L.`);
    await setStatus(suspended.agencyId, 'SUSPENDED');
    await verifiedAgency(`Solx${t} Wildcard S.L.`); // `_` must not match any character

    const search = (q: string, m: { userId: string; agencyId: string } = owner) =>
      as(m, (ctx) => agencies.searchAgencyDirectory(ctx, { q }));
    const found = await search(`sol_${t}`);
    expect(found.items).toEqual([
      { agencyId: match.agencyId, name: `Inmobiliaria Sol_${t} S.L.`, kind: 'AGENCY', preferred: false },
    ]);
    expect((await search(`Searcher ${t}`)).items).toEqual([]); // never itself

    await as(owner, (ctx) => agencies.addPreferredAgency(ctx, { agencyId: match.agencyId }));
    expect((await search(`sol_${t}`)).items[0]?.preferred).toBe(true);

    expect(await refusal(search(`sol_${t}`, pending))).toBe('VERIFICATION_REQUIRED');
    expect(
      await refusal(as(owner, (ctx) => agencies.searchAgencyDirectory(ctx, { q: 'sol' }), { clientMode: true })),
    ).toBe('FORBIDDEN');
  });
});

describe('direct table writes (S1-07)', () => {
  it('[S1-07] tenants cannot bypass the service rules with direct writes', async () => {
    const owner = await verifiedAgency(`Owner ${tag()} S.L.`);
    const partner = await verifiedAgency(`Partner ${tag()} S.L.`);
    const pending = await createFounder({ companyName: `Pending ${tag()} S.L.` });
    const agent = await agentOf(owner);
    const write = (m: { userId: string; agencyId: string }, q: ReturnType<typeof sql>) =>
      refusal(withTenant({ agencyId: m.agencyId, userId: m.userId }, (tx) => tx.execute(q)));
    const prefer = (agencyId: string, preferred: string) =>
      sql`insert into preferred_agencies (agency_id, preferred_agency_id) values (${agencyId}, ${preferred})`;

    expect(await write(agent, prefer(owner.agencyId, partner.agencyId))).toBe('42501'); // not an admin
    expect(await write(owner, prefer(owner.agencyId, pending.agencyId))).toBe('42501'); // not verified
    expect(await write(pending, prefer(pending.agencyId, partner.agencyId))).toBe('42501'); // owner not verified
    expect(await write(owner, prefer(owner.agencyId, owner.agencyId))).toBe('23514'); // itself: CHECK constraint
    expect(
      await write(
        owner,
        sql`update agency_directory set name = 'Renamed', listed = true where agency_id = ${owner.agencyId}`,
      ),
    ).toBe('42501');
    expect(
      await write(
        pending,
        sql`insert into agency_directory (agency_id, name, kind, listed) values (${pending.agencyId}, 'Me', 'AGENCY', true)`,
      ),
    ).toBe('42501');

    await as(owner, (ctx) => agencies.addPreferredAgency(ctx, { agencyId: partner.agencyId, note: 'private' }));
    expect(
      await write(
        owner,
        sql`update preferred_agencies set preferred_agency_id = ${pending.agencyId} where agency_id = ${owner.agencyId}`,
      ),
    ).toBe('42501');
    expect(
      await write(agent, sql`update preferred_agency_notes set note = 'agent' where agency_id = ${owner.agencyId}`),
    ).toBe('42501');

    // The partner reads the relationship naming it, never the owner's note.
    const notes = await withTenant(
      { agencyId: partner.agencyId },
      async (tx) =>
        (await tx.execute(sql`select note from preferred_agency_notes where agency_id = ${owner.agencyId}`)).rows,
    );
    expect(notes).toEqual([]);
  });
});
