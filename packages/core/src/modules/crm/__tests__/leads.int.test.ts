import {
  CreateContactBody,
  type CreateContactInput,
  CreateLeadBody,
  type CreateLeadInput,
  CreateListingBody,
  type CreateSiteInput,
  UpdateListingBody,
} from '@inmolink/contracts';
import { closeDb, countQueries, withIntake, withSystem, withTenant } from '@inmolink/db';
import { adminQuery, setAgencyStatus, setupTestDb, withAdminRollback } from '@inmolink/db/testing';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { closeQueues, configureQueue, registerPool } from '@inmolink/platform/queue';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import * as websites from '../../websites';
import * as crm from '../index';

/**
 * Leads, routing and inbox (S10-02): website leads promoted once into the presenting agency's inbox, routed by source
 * (PLAN §3 #12), assigned by the agency's rule; the owner of a network listing sees the introducer, never the client;
 * the inbox is a keyset list on indexes RLS can use.
 */

const RUN = newId().slice(-8).toLowerCase();
const LEADS_FOR_P95 = 20;
const log = createLogger({ service: 'crm-leads-test', level: 'silent' });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('crm.leads.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

/** `a` presents (its website), `b` owns network listings, `c` is unverified. */
let a: Founder;
let b: Founder;
let c: Founder;
/** A plain agent of `a`. */
let agentId: string;
let siteId: string;
let ids: { city: string; villa: string };
let bListing: string;
let aListingOfAgent: string;

const as = <T>(m: { userId: string; agencyId: string }, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const asAgent = <T>(fn: (ctx: Ctx) => Promise<T>) => as({ userId: agentId, agencyId: a.agencyId }, fn);
const email = (name: string) => `${name}-${RUN}@example.com`;

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

/** The SQLSTATE a statement fails with (`ok` when it succeeds). */
async function sqlState(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? 'unknown';
  }
}

async function listing(m: { userId: string; agencyId: string }, priceCents: number): Promise<string> {
  const { id } = await as(m, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({ propertyTypeId: ids.villa, locationId: ids.city, priceCents, energyRating: 'B' }),
    ),
  );
  await as(m, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility: 'SHARED',
        shareScope: 'ALL',
        version: (await properties.getListing(ctx, id)).version,
      }),
    ),
  );
  return id;
}

/** A website form's lead on `a`'s site, through the intake path (`app_intake`, with its `websites.lead.received`). */
async function inbound(
  over: {
    email?: string;
    phone?: string | null;
    name?: string;
    target?: { kind: 'LISTING' | 'UNIT'; id: string; ownerAgencyId: string | null; shownRef: string } | null;
  } = {},
): Promise<string> {
  const id = newId();
  const { created } = await withIntake({ agencyId: a.agencyId }, (tx) =>
    websites.recordInboundLead(tx, {
      id,
      agencyId: a.agencyId,
      siteId,
      kind: 'ENQUIRY',
      idempotencyHash: `idem-${id}`,
      requestHash: 'x',
      verification: 'SERVER_KEY',
      target: over.target ?? null,
      locale: 'en',
      name: over.name ?? 'Vera Visitor',
      email: over.email ?? email(`visitor-${id.slice(-6)}`),
      emailHash: `h-${id}`,
      keyTier: 'STANDARD',
      phone: over.phone ?? null,
      message: 'Is the villa still available?',
      viewingSlots: null,
      marketingConsent: true,
      pageUrl: null,
    }),
  );
  expect(created).toBe(true);
  return id;
}

const leadOf = (inboundId: string) =>
  rows<{ id: string; agency_id: string; contact_id: string; assigned_user_id: string | null; owner_agency_id: string }>(
    sql`select id, agency_id, contact_id, assigned_user_id, owner_agency_id from leads where inbound_lead_id = ${inboundId}`,
  );

const setRule = async (mode: 'UNASSIGNED' | 'ROUND_ROBIN' | 'OWNER_AGENT', agentUserIds: string[] = []) => {
  const current = await as(a, (ctx) => crm.getLeadRouting(ctx));
  return as(a, (ctx) => crm.updateLeadRouting(ctx, { version: current.version, mode, agentUserIds }));
};

beforeAll(async () => {
  await setupTestDb('worker');
  [a, b, c] = await Promise.all([createFounder(), createFounder(), createFounder()]);
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  agentId = newId();
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${agentId}, ${`lead-agent-${agentId}@example.com`}, 'x', 'Agent', 'es', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${a.agencyId}, ${agentId}, 'AGENT', 'Agent', ${`lead-agent-${agentId}@example.com`})`);
  });
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const city = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `crm-ld-${RUN}`,
      translations: name('Leadcountry'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `crm-ld-g-${RUN}`,
      sort: 0,
      translations: name('Homes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `crm-ld-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
  bListing = await listing(b, 50_000_000);
  aListingOfAgent = await listing({ userId: agentId, agencyId: a.agencyId }, 40_000_000);
  const site: CreateSiteInput = {
    name: 'Lead Homes web',
    domains: [`www.lead-homes-${RUN}.example`],
    mode: 'WP_PLUGIN',
    inventoryPolicy: 'OWN_ONLY',
    inventoryFilters: null,
    referencePrefix: 'LH',
    locales: ['en', 'es'],
    contact: { name: 'Lead Homes', email: 'office@lead-homes.example', phone: '+34 600 000 002' },
  };
  siteId = (await as(a, (ctx) => websites.createSite(ctx, site))).id;
}, 180_000);

afterAll(async () => {
  await closeQueues();
  await closeDb();
});

describe('promotion of website leads', () => {
  it('[S10-02] a website lead lands once in the presenting agency’s inbox, the visitor as its contact', async () => {
    const visitor = email('ana-web');
    const first = await inbound({ email: visitor, phone: '600 111 222', name: 'Ana Web' });
    const promoted = await crm.promoteInboundLead({ agencyId: a.agencyId, inboundLeadId: first });
    expect(promoted.created).toBe(true);
    // a redelivered event (or a retry) changes nothing
    expect(await crm.promoteInboundLead({ agencyId: a.agencyId, inboundLeadId: first })).toEqual({
      leadId: promoted.leadId,
      created: false,
    });
    const [lead] = await leadOf(first);
    expect(lead?.agency_id).toBe(a.agencyId);

    const dto = await as(a, (ctx) => crm.getLead(ctx, promoted.leadId as string));
    expect(dto).toMatchObject({
      source: 'WEBSITE',
      kind: 'ENQUIRY',
      status: 'NEW',
      presentingAgencyId: a.agencyId,
      ownerAgencyId: null,
      target: null,
      message: 'Is the villa still available?',
      inboundLeadId: first,
      contact: { firstName: 'Ana Web', primaryEmail: visitor, primaryPhone: '+34600111222' },
    });
    const contact = await as(a, (ctx) => crm.getContact(ctx, dto.contact.id));
    expect(contact).toMatchObject({ source: 'WEBSITE', types: ['BUYER'], consentMarketing: true, language: 'en' });

    expect(dto.visitor).toEqual({
      name: 'Ana Web',
      email: visitor,
      phone: '600 111 222',
      marketingConsent: true,
    });

    // the same address again (anyone can type it): the same contact, a second lead — the contact is never rewritten
    // (name, phone, consent); the form's details stay on the lead
    const second = await inbound({ email: visitor.toUpperCase(), name: 'Someone Else', phone: '600 999 888' });
    const again = await crm.promoteInboundLead({ agencyId: a.agencyId, inboundLeadId: second });
    const secondLead = await as(a, (ctx) => crm.getLead(ctx, again.leadId as string));
    expect(secondLead.contact.id).toBe(dto.contact.id);
    expect(secondLead.visitor).toMatchObject({ name: 'Someone Else', phone: '600 999 888' });
    const unchanged = await as(a, (ctx) => crm.getContact(ctx, dto.contact.id));
    expect(unchanged).toEqual(contact);

    // another agency's job for the same inbound lead finds nothing (RLS: the lead is the site agency's)
    expect(await crm.promoteInboundLead({ agencyId: b.agencyId, inboundLeadId: newId() })).toEqual({
      leadId: null,
      created: false,
    });
  });

  it('[S10-02] website lead lands in the right agency inbox in < 10 s p95 (event → outbox → promote job)', async () => {
    const queuePrefix = `crmleads${RUN}`;
    await configureQueue({ prefix: queuePrefix, logger: log });
    crm.registerCrmSubscriptions();
    // the worker's email pool options (`apps/worker` POOL_OPTIONS): a waiting promotion re-polls within 1 s
    const pool = registerPool('email', [crm.crmJobs.promoteInboundLead], {
      shutdownMs: 5_000,
      groupRetryMs: 100,
      groupRetryMaxMs: 1_000,
    });
    // The dispatcher's delivery, for this test's agency only (the shared test database's other events belong to
    // other test files): poll every 250 ms (ADR 0014), claim, hand to the subscribers, acknowledge.
    let dispatching = true;
    const dispatcher = (async () => {
      while (dispatching) {
        const claimed = await adminQuery<{
          id: string;
          agency_id: string;
          type: string;
          version: number;
          payload: unknown;
          created_at: Date;
        }>(
          `update outbox_events set processed_at = now(), attempts = attempts + 1
            where id in (select id from outbox_events
                          where agency_id = $1 and type = 'websites.lead.received' and processed_at is null
                          order by available_at, id limit 50 for update skip locked)
           returning id, agency_id, type, version, payload, created_at`,
          [a.agencyId],
        );
        for (const row of claimed) {
          for (const sub of defaultSubscribers.get(row.type, row.version)) {
            if (!sub.name.startsWith('crm.')) continue;
            await sub.handler(sub.def.schema.parse(row.payload), {
              eventId: row.id,
              agencyId: row.agency_id,
              type: row.type,
              version: row.version,
              createdAt: new Date(row.created_at),
              attempt: 1,
            });
          }
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    try {
      await setRule('ROUND_ROBIN', [a.userId, agentId]);
      // a burst of website leads, half about the partner's network listing
      const inboundIds = await Promise.all(
        Array.from({ length: LEADS_FOR_P95 }, (_, i) =>
          inbound({
            target: i % 2 ? { kind: 'LISTING', id: bListing, ownerAgencyId: b.agencyId, shownRef: 'LH-X1' } : null,
          }),
        ),
      );
      const deadline = Date.now() + 60_000;
      let landed: { latency_ms: number; agency_id: string; assigned_user_id: string | null }[] = [];
      while (Date.now() < deadline) {
        landed = await rows(sql`
          select l.agency_id, l.assigned_user_id,
                 extract(epoch from (l.created_at - w.created_at)) * 1000 as latency_ms
            from leads l join website_leads w on w.id = l.inbound_lead_id
           where l.inbound_lead_id = any(${sql.param(inboundIds)}::uuid[])`);
        if (landed.length === LEADS_FOR_P95) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(landed).toHaveLength(LEADS_FOR_P95);
      // the right inbox: the presenting agency's, also for the partner's listing (§3 #12), assigned by its rule
      expect(new Set(landed.map((l) => l.agency_id))).toEqual(new Set([a.agencyId]));
      expect(new Set(landed.map((l) => l.assigned_user_id))).toEqual(new Set([a.userId, agentId]));
      const latencies = landed.map((l) => Number(l.latency_ms)).sort((x, y) => x - y);
      const p95 = latencies[Math.ceil(0.95 * latencies.length) - 1] as number;
      console.info(
        `[S10-02] website lead → inbox: ${LEADS_FOR_P95} leads, p50 ${Math.round(latencies[Math.floor(latencies.length / 2)] as number)} ms, p95 ${Math.round(p95)} ms, max ${Math.round(latencies.at(-1) as number)} ms`,
      );
      expect(p95).toBeLessThan(10_000);
    } finally {
      dispatching = false;
      await dispatcher;
      crm.unregisterCrmSubscriptions();
      await pool.close();
      await setRule('UNASSIGNED');
    }
  }, 120_000);
});

describe('the owner of a network listing', () => {
  it('[S10-02] listing owner sees introducer agency but never the client’s PII before registration', async () => {
    const visitor = email('nico-net');
    const inboundId = await inbound({
      email: visitor,
      phone: '600 333 444',
      name: 'Nico Network',
      target: { kind: 'LISTING', id: bListing, ownerAgencyId: b.agencyId, shownRef: 'LH-B1' },
    });
    const { leadId } = await crm.promoteInboundLead({ agencyId: a.agencyId, inboundLeadId: inboundId });
    // the presenting agency holds the lead and its client
    const held = await as(a, (ctx) => crm.getLead(ctx, leadId as string));
    expect(held).toMatchObject({
      presentingAgencyId: a.agencyId,
      ownerAgencyId: b.agencyId,
      target: { kind: 'LISTING', id: bListing, shownRef: 'LH-B1' },
      contact: { primaryEmail: visitor },
    });

    // the owner sees who introduced a client for which listing …
    const page = await as(b, (ctx) => crm.listLeadIntroductions(ctx, { limit: 100 }));
    const intro = page.items.find((i) => i.leadId === leadId);
    expect(intro).toMatchObject({
      introducerAgencyId: a.agencyId,
      source: 'WEBSITE',
      kind: 'ENQUIRY',
      handEntered: false,
      target: { kind: 'LISTING', id: bListing },
    });
    // … and nothing of the client: not in the answer, not in the lead, not in the contact
    const seen = JSON.stringify(page);
    for (const pii of [visitor, 'Nico Network', '+34600333444', '600 333 444', 'still available', held.contact.id]) {
      expect(seen).not.toContain(pii);
    }
    expect(await refusal(as(b, (ctx) => crm.getLead(ctx, leadId as string)))).toBe('LEAD_NOT_FOUND');
    expect(await refusal(as(b, (ctx) => crm.getContact(ctx, held.contact.id)))).toBe('CONTACT_NOT_FOUND');
    const bInbox = await as(b, (ctx) => crm.listLeads(ctx, { limit: 100 }));
    expect(bInbox.items.some((l) => l.id === leadId)).toBe(false);

    // under RLS, as the owner: the introduction row only, and no column of it names the client
    const seenRaw = await withTenant({ agencyId: b.agencyId }, async (tx) => ({
      leads: (await tx.execute(sql`select id from leads where id = ${leadId}`)).rows.length,
      website: (await tx.execute(sql`select id from website_leads where id = ${inboundId}`)).rows.length,
      intro: (await tx.execute(sql`select * from lead_introductions where lead_id = ${leadId}`)).rows,
    }));
    expect(seenRaw.leads).toBe(0);
    expect(seenRaw.website).toBe(0);
    expect(seenRaw.intro).toHaveLength(1);
    expect(Object.keys(seenRaw.intro[0] as object).sort()).toEqual(
      [
        'agency_id',
        'created_at',
        'created_ms',
        'hand_entered',
        'kind',
        'lead_id',
        'owner_agency_id',
        'source',
        'target_id',
        'target_kind',
      ].sort(),
    );
    // immutable: neither the owner nor the introducer may change or remove it (no UPDATE / DELETE grant)
    for (const agency of [b.agencyId, a.agencyId]) {
      for (const stmt of [
        sql`update lead_introductions set target_id = ${newId()} where lead_id = ${leadId}`,
        sql`delete from lead_introductions where lead_id = ${leadId}`,
      ]) {
        expect(await sqlState(withTenant({ agencyId: agency }, (tx) => tx.execute(stmt)))).toBe('42501');
      }
    }
    // an unverified agency named as owner reads nothing (NETWORK_READ needs a verified reader)
    const unverified = await withTenant(
      { agencyId: c.agencyId },
      async (tx) =>
        (await tx.execute(sql`select lead_id from lead_introductions where lead_id = ${leadId}`)).rows.length,
    );
    expect(unverified).toBe(0);
  });

  it('[S10-02] a manual lead on a network listing is the presenting agency’s, introduced to the owner', async () => {
    const contact = await createContact(a, { firstName: 'Mila', emails: [email('mila')] });
    const lead = await createLead(a, { contactId: contact.id, target: { kind: 'LISTING', id: bListing } });
    expect(lead).toMatchObject({ source: 'MANUAL', ownerAgencyId: b.agencyId, presentingAgencyId: a.agencyId });
    expect(lead.target).toEqual({ kind: 'LISTING', id: bListing, shownRef: null });
    const page = await as(b, (ctx) => crm.listLeadIntroductions(ctx, { limit: 100 }));
    // the owner can tell a hand-entered introduction from a client's own enquiry
    expect(page.items.find((i) => i.leadId === lead.id)).toMatchObject({ source: 'MANUAL', handEntered: true });
    // the holder removing its lead removes the introduction too (cascade as the table owner, not an app_user delete)
    expect(
      await sqlState(
        withTenant({ agencyId: a.agencyId }, (tx) => tx.execute(sql`delete from leads where id = ${lead.id}`)),
      ),
    ).toBe('ok');
    expect(await rows(sql`select 1 from lead_introductions where lead_id = ${lead.id}`)).toEqual([]);
    // a target the agency cannot see is refused
    expect(await refusal(createLead(a, { contactId: contact.id, target: { kind: 'LISTING', id: newId() } }))).toBe(
      'LEAD_TARGET_NOT_FOUND',
    );
  });
});

const createContact = (m: Founder, body: CreateContactInput) =>
  as(m, async (ctx) => (await crm.createContact(ctx, CreateContactBody.parse(body))).contact);
const createLead = (m: Founder, body: CreateLeadInput, opts: { idempotencyKey?: string } = {}) =>
  as(m, async (ctx) => (await crm.createLead(ctx, CreateLeadBody.parse(body), opts)).lead);

describe('assignment', () => {
  it('[S10-02] round robin takes turns; the owner-agent rule gives the agent their own listing’s leads', async () => {
    try {
      await setRule('ROUND_ROBIN', [a.userId, agentId]);
      const turns: (string | null)[] = [];
      for (let i = 0; i < 4; i++) {
        const id = await inbound();
        await crm.promoteInboundLead({ agencyId: a.agencyId, inboundLeadId: id });
        turns.push((await leadOf(id))[0]?.assigned_user_id ?? null);
      }
      expect(new Set(turns)).toEqual(new Set([a.userId, agentId]));
      expect(turns[0]).not.toBe(turns[1]);
      expect(turns[0]).toBe(turns[2]);
      expect(turns[1]).toBe(turns[3]);

      await setRule('OWNER_AGENT');
      const own = await inbound({
        target: { kind: 'LISTING', id: aListingOfAgent, ownerAgencyId: null, shownRef: 'LH-A1' },
      });
      await crm.promoteInboundLead({ agencyId: a.agencyId, inboundLeadId: own });
      expect((await leadOf(own))[0]?.assigned_user_id).toBe(agentId);
      // a general enquiry has no listing agent: round robin over every active member
      const general = await inbound();
      await crm.promoteInboundLead({ agencyId: a.agencyId, inboundLeadId: general });
      expect((await leadOf(general))[0]?.assigned_user_id).not.toBeNull();

      await setRule('UNASSIGNED');
      const waiting = await inbound();
      await crm.promoteInboundLead({ agencyId: a.agencyId, inboundLeadId: waiting });
      expect((await leadOf(waiting))[0]?.assigned_user_id).toBeNull();

      // the pool takes active members only; only admins set the rule
      expect(await refusal(setRule('ROUND_ROBIN', [newId()]))).toBe('VALIDATION_FAILED');
      expect(
        await refusal(
          asAgent((ctx) => crm.updateLeadRouting(ctx, { version: 1, mode: 'ROUND_ROBIN', agentUserIds: [] })),
        ),
      ).toBe('FORBIDDEN');
    } finally {
      await setRule('UNASSIGNED');
    }
  });

  it('[S10-02] concurrent leads take even turns in the round robin', async () => {
    try {
      await setRule('ROUND_ROBIN', [a.userId, agentId]);
      const ids = await Promise.all(Array.from({ length: 6 }, () => inbound()));
      await Promise.all(ids.map((id) => crm.promoteInboundLead({ agencyId: a.agencyId, inboundLeadId: id })));
      const assigned = await rows<{ assigned_user_id: string }>(
        sql`select assigned_user_id from leads where inbound_lead_id = any(${sql.param(ids)}::uuid[])`,
      );
      const count = (u: string) => assigned.filter((r) => r.assigned_user_id === u).length;
      expect([count(a.userId), count(agentId)]).toEqual([3, 3]);
    } finally {
      await setRule('UNASSIGNED');
    }
  });

  it('[S10-02] the website e-mail goes to the assigned agent (crm.lead.created names it)', async () => {
    try {
      await setRule('ROUND_ROBIN', [agentId]);
      const id = await inbound();
      const { leadId } = await crm.promoteInboundLead({ agencyId: a.agencyId, inboundLeadId: id });
      const events = await rows<{ payload: { assignedUserId: string | null; inboundLeadId: string } }>(
        sql`select payload from outbox_events where type = 'crm.lead.created' and agency_id = ${a.agencyId}
            and payload->>'leadId' = ${leadId}`,
      );
      expect(events.map((e) => e.payload)).toMatchObject([{ assignedUserId: agentId, inboundLeadId: id }]);
    } finally {
      await setRule('UNASSIGNED');
    }
  });
});

describe('the inbox', () => {
  it('[S10-02] manual leads: Idempotency-Key replays, status leaves NEW once, assignment by hand, stale versions conflict', async () => {
    const contact = await createContact(a, { firstName: 'Olga', emails: [email('olga')] });
    const key = `lead-key-${RUN}-0001`;
    const first = await as(a, (ctx) =>
      crm.createLead(ctx, CreateLeadBody.parse({ contactId: contact.id, message: 'Call back' }), {
        idempotencyKey: key,
      }),
    );
    const again = await as(a, (ctx) =>
      crm.createLead(ctx, CreateLeadBody.parse({ contactId: contact.id, message: 'Call back' }), {
        idempotencyKey: key,
      }),
    );
    expect(first.replayed).toBe(false);
    expect(again).toEqual({ lead: first.lead, replayed: true });
    // the same key with another body is refused, never replayed
    expect(
      await refusal(
        as(a, (ctx) =>
          crm.createLead(ctx, CreateLeadBody.parse({ contactId: contact.id, message: 'Something else' }), {
            idempotencyKey: key,
          }),
        ),
      ),
    ).toBe('IDEMPOTENCY_KEY_REUSED');

    const moved = await as(a, (ctx) =>
      crm.updateLead(ctx, first.lead.id, {
        version: first.lead.version,
        status: 'IN_PROGRESS',
        assignedUserId: agentId,
      }),
    );
    expect(moved).toMatchObject({ status: 'IN_PROGRESS', assignedUserId: agentId });
    expect(moved.firstRespondedAt).not.toBeNull();
    const won = await as(a, (ctx) => crm.updateLead(ctx, moved.id, { version: moved.version, status: 'WON' }));
    expect(won.firstRespondedAt).toBe(moved.firstRespondedAt);
    expect(await refusal(as(a, (ctx) => crm.updateLead(ctx, moved.id, { version: 1, status: 'LOST' })))).toBe(
      'VERSION_CONFLICT',
    );
    expect(
      await refusal(as(a, (ctx) => crm.updateLead(ctx, moved.id, { version: won.version, assignedUserId: newId() }))),
    ).toBe('VALIDATION_FAILED');
    // another agency's contact is not a lead's client
    const theirs = await createContact(b, { firstName: 'Pia', emails: [email('pia')] });
    expect(await refusal(createLead(a, { contactId: theirs.id }))).toBe('CONTACT_NOT_FOUND');
  });

  it('[S10-02] lists newest first by keyset in one query, filtered by assignee and status', async () => {
    const contact = await createContact(a, { firstName: 'Quim', emails: [email('quim')] });
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      made.push((await createLead(a, { contactId: contact.id, assignedUserId: i % 2 ? agentId : null })).id);
    }
    const mine = await asAgent((ctx) => crm.listLeads(ctx, { limit: 100, assigned: 'me' }));
    const ofAgent = made.filter((_, i) => i % 2);
    expect(mine.items.filter((l) => made.includes(l.id)).map((l) => l.id)).toEqual([...ofAgent].reverse());
    const first = await as(a, (ctx) => crm.listLeads(ctx, { limit: 2 }));
    expect(first.items.map((l) => l.id)).toEqual(made.slice(-2).reverse());
    const second = await as(a, (ctx) => crm.listLeads(ctx, { limit: 2, cursor: first.nextCursor ?? '' }));
    expect(second.items.map((l) => l.id)).toEqual(made.slice(1, 3).reverse());
    expect(second.items[0]?.contact).toMatchObject({ id: contact.id, firstName: 'Quim' });

    const setup = await countQueries(() => as(a, async () => null)); // the member's ctx (membership, tenant)
    const list = await countQueries(() => as(a, (ctx) => crm.listLeads(ctx, { limit: 100, status: 'NEW' })));
    expect(list - setup).toBe(1);
    const intro = await countQueries(() => as(b, (ctx) => crm.listLeadIntroductions(ctx, { limit: 100 })));
    expect(intro - setup).toBeLessThanOrEqual(2);
    // the worst path: an Idempotency-Key, a network target, a round-robin turn
    try {
      await setRule('ROUND_ROBIN', [a.userId, agentId]);
      const create = await countQueries(() =>
        createLead(
          a,
          { contactId: contact.id, target: { kind: 'LISTING', id: bListing } },
          { idempotencyKey: `lead-key-${RUN}-count` },
        ),
      );
      expect(create - setup).toBeLessThanOrEqual(10);
    } finally {
      await setRule('UNASSIGNED');
    }
  });

  it('[S10-02] the inbox and introduction lists are index conditions under RLS, deep pages included', async () => {
    // At scale: a 5,000-lead agency among 200 others (25k leads, introductions to one owner); FK checks off in this
    // rolled-back seed; analysed, EXPLAINed as app_user (RLS on).
    const plans = await withAdminRollback(['leads', 'lead_introductions'], async (q) => {
      await q('set local session_replication_role = replica');
      await q(
        `insert into leads (id, agency_id, contact_id, source, status, assigned_user_id, assigned_at, created_at)
         select gen_random_uuid(), $1, gen_random_uuid(), case when g % 20 = 0 then 'PORTAL' else 'WEBSITE' end,
                case when g % 10 = 0 then 'WON' else 'NEW' end,
                case when g % 5 = 0 then $2::uuid end, case when g % 5 = 0 then now() end, now() - g * interval '1 minute'
         from generate_series(1, 5000) g`,
        [a.agencyId, agentId],
      );
      await q(
        `insert into leads (id, agency_id, contact_id, source)
         select gen_random_uuid(), ag.id, gen_random_uuid(), 'MANUAL'
         from (select gen_random_uuid() as id from generate_series(1, 200)) ag, generate_series(1, 100) g`,
      );
      await q(
        `insert into lead_introductions (lead_id, agency_id, owner_agency_id, source, target_kind, target_id, created_at)
         select id, agency_id, case when random() < 0.02 then $1::uuid else gen_random_uuid() end, 'WEBSITE', 'LISTING',
                gen_random_uuid(), created_at
         from leads where source = 'MANUAL' and agency_id <> $1 and agency_id <> $2
           and not exists (select 1 from lead_introductions i where i.lead_id = leads.id)`,
        [b.agencyId, a.agencyId],
      );
      await q('analyze leads');
      await q('analyze lead_introductions');
      await q('set local role app_user');
      const explain = async (agency: string, text: string, values: unknown[]) => {
        await q(`select set_config('app.agency_id', $1, true)`, [agency]);
        const out = await q(`explain ${text}`, values);
        return out.map((r) => String(Object.values(r)[0])).join('\n');
      };
      // a deep page: the cursor half-way down the agency's leads (the repo's row comparison on the stored column)
      const cursor = `and (created_ms, id) < (now() - interval '2500 minutes', 'ffffffff-ffff-7fff-bfff-ffffffffffff'::uuid)`;
      const order = `order by created_ms desc, id desc limit 26`;
      const leadsOf = (extra: string) => `select id from leads where agency_id = $1 ${extra} ${cursor} ${order}`;
      return {
        inbox: await explain(a.agencyId, leadsOf(''), [a.agencyId]),
        mine: await explain(a.agencyId, leadsOf('and assigned_user_id = $2'), [a.agencyId, agentId]),
        unassigned: await explain(a.agencyId, leadsOf('and assigned_user_id is null'), [a.agencyId]),
        status: await explain(a.agencyId, leadsOf('and status = $2'), [a.agencyId, 'WON']),
        source: await explain(a.agencyId, leadsOf('and source = $2'), [a.agencyId, 'PORTAL']),
        intro: await explain(
          b.agencyId,
          `select lead_id from lead_introductions where owner_agency_id = $1
             and (created_ms, lead_id) < (now(), 'ffffffff-ffff-7fff-bfff-ffffffffffff'::uuid)
           order by created_ms desc, lead_id desc limit 26`,
          [b.agencyId],
        ),
      };
    });
    expect(plans.inbox).toContain('leads_agency_created_idx');
    expect(plans.mine).toContain('leads_agency_assigned_created_idx');
    // most leads are unassigned: either index serves it, never a scan
    expect(plans.unassigned).toMatch(/leads_agency_(assigned_)?created_idx/);
    expect(plans.status).toContain('leads_agency_status_created_idx');
    expect(plans.source).toContain('leads_agency_source_created_idx');
    expect(plans.intro).toContain('lead_introductions_owner_created_idx');
    // the cursor is an index condition (RLS on: a plain column's row comparison is leakproof), never a Filter
    for (const [name, text] of Object.entries(plans)) {
      const cond = text.split('\n').filter((l) => l.includes('Index Cond'));
      expect(cond.join(' '), name).toMatch(/ROW\(created_ms, (id|lead_id)\) </);
      // (a bitmap heap scan rechecks every qual as a Filter: that is no extra read)
      if (!text.includes('Bitmap Heap Scan')) expect(text, name).not.toMatch(/Filter: .*created_ms/);
    }
    for (const text of Object.values(plans)) expect(text).not.toMatch(/Seq Scan/);
  });

  it('[S10-02] Client Mode never shows leads, introductions or the rule', async () => {
    const client = <T>(fn: (ctx: Ctx) => Promise<T>) => as(a, (ctx) => fn({ ...ctx, clientMode: true }));
    expect(await refusal(client((ctx) => crm.listLeads(ctx, { limit: 10 })))).toBe('FORBIDDEN');
    expect(await refusal(client((ctx) => crm.listLeadIntroductions(ctx, { limit: 10 })))).toBe('FORBIDDEN');
    expect(await refusal(client((ctx) => crm.getLeadRouting(ctx)))).toBe('FORBIDDEN');
  });
});
