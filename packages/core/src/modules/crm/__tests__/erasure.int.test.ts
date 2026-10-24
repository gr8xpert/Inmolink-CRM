import {
  ConvertProspectBody,
  CreateActivityBody,
  CreateCalendarEventBody,
  CreateContactBody,
  CreateContactNoteBody,
  CreateLeadBody,
  CreateProspectBody,
  type CreateProspectInput,
  type CreateSiteInput,
  CreateTaskBody,
} from '@inmolink/contracts';
import { closeDb, withIntake, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder, impersonatedCtx } from '../../../testing/factories';
import * as taxonomy from '../../taxonomy';
import * as websites from '../../websites';
import * as crm from '../index';

/**
 * Contact erasure (S11-F12): the contact becomes a tombstone; its identifiers, notes, lead messages, task descriptions
 * and prospect notes go in the request; its activity bodies and the listings naming it as seller follow
 * `crm.contact.erased` (`crm.eraseContactData`). Ids and timestamps stay.
 */

const RUN = newId().slice(-8).toLowerCase();
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('crm.erasure.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const STAFF = '01900000-0000-7000-8000-0000000000bb';
const SECRET = `Sofia Erased divorcing ${RUN}`;

let a: Founder;
let b: Founder;
let siteId: string;
let ids: { city: string; villa: string };

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

const contact = async (name: string) =>
  (
    await as(a, (ctx) =>
      crm.createContact(
        ctx,
        CreateContactBody.parse({
          firstName: name,
          lastName: 'Erased',
          emails: [`${name}-${RUN}@example.com`],
          phones: [`+3460${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`],
          types: ['SELLER'],
          tags: [`tag-${RUN}`],
        }),
      ),
    )
  ).contact;

/** A prospect of `contactId` with confidential notes, converted: the listing names the contact as seller. */
async function soldListing(contactId: string, name: string): Promise<{ prospectId: string; listingId: string }> {
  const body: CreateProspectInput = {
    title: `${name} ${RUN}`,
    contactId,
    propertyTypeId: ids.villa,
    locationId: ids.city,
    confidentialNotes: SECRET,
  };
  const { prospect } = await as(a, (ctx) => crm.createProspect(ctx, CreateProspectBody.parse(body)));
  const { listingId } = await as(a, (ctx) => crm.convertProspect(ctx, prospect.id, ConvertProspectBody.parse({})));
  return { prospectId: prospect.id, listingId };
}

/** Delivers the contact's `crm.contact.erased` event to the real subscription, running the queued job inline. */
async function deliverErased(
  contactId: string,
  times: number,
): Promise<{ activities: number; inboundLeads: number; listings: number }[]> {
  const [event] = await rows<{ id: string; type: string; version: number; payload: unknown; created_at: string }>(
    sql`select id, type, version, payload, created_at from outbox_events
         where type = 'crm.contact.erased' and agency_id = ${a.agencyId} and payload->>'contactId' = ${contactId}`,
  );
  expect(event).toBeDefined();
  const job = crm.crmJobs.eraseContactData;
  const results: { activities: number; inboundLeads: number; listings: number }[] = [];
  const spy = vi.spyOn(job, 'enqueue').mockImplementation(async (payload) => {
    const p = job.spec.payload.parse(payload);
    expect(p.eventId).toBe(event?.id);
    results.push(await crm.eraseContactData(p));
    return { id: 'inline', added: true } as unknown as Awaited<ReturnType<typeof job.enqueue>>;
  });
  crm.registerCrmSubscriptions();
  try {
    const [sub] = defaultSubscribers.get('crm.contact.erased', 1).filter((s) => s.name === 'crm.contact.eraseData');
    expect(sub).toBeDefined();
    for (let i = 0; i < times; i++) {
      if (!event || !sub) continue;
      await sub.handler(sub.def.schema.parse(event.payload), {
        eventId: event.id,
        agencyId: a.agencyId,
        type: event.type,
        version: event.version,
        createdAt: new Date(event.created_at),
        attempt: 1,
      });
    }
  } finally {
    crm.unregisterCrmSubscriptions();
    spy.mockRestore();
  }
  return results;
}

beforeAll(async () => {
  await setupTestDb('worker');
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  const site: CreateSiteInput = {
    name: 'Erasure Homes web',
    domains: [`www.erasure-homes-${RUN}.example`],
    mode: 'WP_PLUGIN',
    inventoryPolicy: 'OWN_ONLY',
    inventoryFilters: null,
    referencePrefix: 'EH',
    locales: ['en'],
    contact: { name: 'Erasure Homes', email: 'office@erasure-homes.example', phone: '+34 600 000 003' },
  };
  siteId = (await as(a, (ctx) => websites.createSite(ctx, site))).id;
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const city = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `crm-er-${RUN}`,
      translations: name('Erasureland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `crm-er-g-${RUN}`,
      sort: 0,
      translations: name('Homes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `crm-er-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
});

afterAll(async () => {
  await closeDb();
});

describe('contact erasure', () => {
  it('[S11-F12] after erasure no listing names the contact as seller and no activity body of theirs remains', async () => {
    const target = await contact('sofia');
    const other = await contact('olga');
    // what crm holds about the contact: a note, a call, a lead with a message and a call on it, a task, a prospect
    await as(a, (ctx) => crm.addContactNote(ctx, target.id, CreateContactNoteBody.parse({ body: SECRET })));
    const log = (body: Record<string, unknown>) => as(a, (ctx) => crm.logActivity(ctx, CreateActivityBody.parse(body)));
    await log({ type: 'CALL', contactId: target.id, body: SECRET });
    const { lead } = await as(a, (ctx) =>
      crm.createLead(ctx, CreateLeadBody.parse({ contactId: target.id, message: SECRET })),
    );
    await log({ type: 'CALL', leadId: lead.id, body: SECRET });
    const { task } = await as(a, (ctx) =>
      crm.createTask(
        ctx,
        CreateTaskBody.parse({ title: `Call back ${RUN}`, description: SECRET, contactId: target.id }),
      ),
    );
    const sold = await soldListing(target.id, 'Sofia villa');
    // the control: another contact's listing, call and prospect stay as they are
    await log({ type: 'CALL', contactId: other.id, body: SECRET });
    const kept = await soldListing(other.id, 'Olga villa');

    const { version } = await as(a, (ctx) => crm.getContact(ctx, target.id));
    expect(
      await refusal(as(a, (ctx) => crm.eraseContact(ctx, target.id, { version: version + 1, confirm: 'ERASE' }))),
    ).toBe('VERSION_CONFLICT');
    expect(
      await refusal(
        as(a, async (ctx) =>
          crm.eraseContact(await impersonatedCtx(ctx, STAFF), target.id, { version, confirm: 'ERASE' }),
        ),
      ),
    ).toBe('FORBIDDEN');
    await as(a, (ctx) => crm.eraseContact(ctx, target.id, { version, confirm: 'ERASE' }));

    // in the request: the tombstone (id, types, source, times kept) and crm's bounded free text
    const [tomb] = await rows<Record<string, unknown>>(
      sql`select first_name, last_name, primary_email, primary_phone, tags, do_not_contact, deleted_at, merged_into_id,
            types, source, created_at from contacts where id = ${target.id}`,
    );
    expect(tomb).toMatchObject({
      first_name: null,
      last_name: null,
      primary_email: null,
      primary_phone: null,
      tags: [],
      do_not_contact: true,
      merged_into_id: null,
      types: ['SELLER'],
    });
    expect(tomb?.deleted_at).not.toBeNull();
    expect(tomb?.created_at).not.toBeNull();
    const [left] = await rows<Record<string, number>>(sql`select
        (select count(*) from contact_emails where contact_id = ${target.id})::int as emails,
        (select count(*) from contact_phones where contact_id = ${target.id})::int as phones,
        (select count(*) from contact_facets where contact_id = ${target.id})::int as facets,
        (select count(*) from contact_notes where contact_id = ${target.id})::int as notes,
        (select count(*) from leads where id = ${lead.id} and message is null)::int as leads,
        (select count(*) from tasks where id = ${task.id} and description is null and title = '—')::int as tasks,
        (select count(*) from seller_prospects where id = ${sold.prospectId} and contact_id is null
           and confidential_notes is null and title = '—')::int as prospects`);
    expect(left).toEqual({ emails: 0, phones: 0, facets: 0, notes: 0, leads: 1, tasks: 1, prospects: 1 });
    expect(await refusal(as(a, (ctx) => crm.getContact(ctx, target.id)))).toBe('CONTACT_NOT_FOUND');
    expect(
      await refusal(as(a, (ctx) => crm.eraseContact(ctx, target.id, { version: version + 1, confirm: 'ERASE' }))),
    ).toBe('CONTACT_NOT_FOUND');
    const audits = await rows<{ metadata: unknown }>(
      sql`select metadata from audit_logs where agency_id = ${a.agencyId} and type = 'crm.contact.erased'
            and target_id = ${target.id}`,
    );
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain('sofia');

    // after the commit, through the real subscription (redelivered: idempotent)
    const results = await deliverErased(target.id, 2);
    expect(results).toEqual([
      // the contact's call, the note's opening, the lead's call
      { activities: 3, inboundLeads: 0, listings: 1 },
      { activities: 0, inboundLeads: 0, listings: 0 },
    ]);
    const sellers = await rows<{ property_id: string; seller_contact_id: string | null }>(
      sql`select property_id, seller_contact_id from property_privates
           where property_id in (${sold.listingId}, ${kept.listingId})`,
    );
    expect(sellers.find((r) => r.property_id === sold.listingId)?.seller_contact_id).toBeNull();
    expect(sellers.find((r) => r.property_id === kept.listingId)?.seller_contact_id).toBe(other.id);
    const [named] = await rows<{ n: number }>(
      sql`select count(*)::int as n from property_privates
           where agency_id = ${a.agencyId} and seller_contact_id = ${target.id}`,
    );
    expect(named?.n).toBe(0);
    const bodies = await rows<{ contact_id: string | null; body: string | null; n: number }>(
      sql`select contact_id, body, count(*)::int as n from activities
           where agency_id = ${a.agencyId} and (contact_id in (${target.id}, ${other.id}) or lead_id = ${lead.id})
           group by contact_id, body`,
    );
    // the activity rows stay (ids, times), without a body; the other contact's call keeps its body
    expect(bodies.filter((r) => r.contact_id !== other.id && r.body !== null)).toEqual([]);
    expect(bodies.filter((r) => r.contact_id !== other.id).reduce((s, r) => s + r.n, 0)).toBeGreaterThanOrEqual(3);
    expect(bodies.find((r) => r.contact_id === other.id && r.body === SECRET)?.n).toBe(1);
    const [otherProspect] = await rows<{ contact_id: string; confidential_notes: string }>(
      sql`select contact_id, confidential_notes from seller_prospects where id = ${kept.prospectId}`,
    );
    expect(otherProspect).toEqual({ contact_id: other.id, confidential_notes: SECRET });
  });

  it('[S11-F12] the closed contacts merged into an erased contact lose their names too', async () => {
    const survivor = await contact('mara');
    const duplicate = await contact('mara2');
    const before = await as(a, (ctx) => crm.getContact(ctx, survivor.id));
    await as(a, (ctx) => crm.mergeContacts(ctx, survivor.id, { duplicateId: duplicate.id, version: before.version }));
    const { version } = await as(a, (ctx) => crm.getContact(ctx, survivor.id));
    await as(a, (ctx) => crm.eraseContact(ctx, survivor.id, { version, confirm: 'ERASE' }));
    const names = await rows<{ first_name: string | null }>(
      sql`select first_name from contacts where id in (${survivor.id}, ${duplicate.id})`,
    );
    expect(names).toEqual([{ first_name: null }, { first_name: null }]);
  });

  it('[S11-F12] website leads, calendar events and merged sellers follow; the job is idempotent and tenant-bound', async () => {
    const target = await contact('wanda');
    const other = await contact('otto');
    // an inbound website lead promoted into a lead of the contact
    const inboundId = newId();
    await withIntake({ agencyId: a.agencyId }, (tx) =>
      websites.recordInboundLead(tx, {
        id: inboundId,
        agencyId: a.agencyId,
        siteId,
        kind: 'ENQUIRY',
        idempotencyHash: `idem-${inboundId}`,
        requestHash: 'x',
        verification: 'SERVER_KEY',
        target: null,
        locale: 'en',
        name: 'Wanda Erased',
        email: `wanda-web-${RUN}@example.com`,
        emailHash: `h-${inboundId}`,
        keyTier: 'STANDARD',
        phone: '+34600999888',
        message: SECRET,
        viewingSlots: null,
        marketingConsent: true,
        pageUrl: 'https://www.example.com/villa',
      }),
    );
    const { lead } = await as(a, (ctx) => crm.createLead(ctx, CreateLeadBody.parse({ contactId: target.id })));
    await system((tx) => tx.execute(sql`update leads set inbound_lead_id = ${inboundId} where id = ${lead.id}`));
    // a contact merged into it earlier was a listing's seller (its merge job has not run yet)
    const duplicate = await contact('wanda2');
    const dupSold = await soldListing(duplicate.id, 'Wanda old villa');
    const before = await as(a, (ctx) => crm.getContact(ctx, target.id));
    await as(a, (ctx) => crm.mergeContacts(ctx, target.id, { duplicateId: duplicate.id, version: before.version }));
    await system((tx) =>
      tx.execute(
        sql`update property_privates set seller_contact_id = ${duplicate.id} where property_id = ${dupSold.listingId}`,
      ),
    );
    // calendar: a meeting with the contact alone, and one with another contact too
    const event = (contactIds: string[], title: string) =>
      as(a, (ctx) =>
        crm.createCalendarEvent(
          ctx,
          CreateCalendarEventBody.parse({
            type: 'MEETING',
            title,
            description: SECRET,
            location: 'Wanda home',
            startsAt: new Date(Date.now() + 86_400_000).toISOString(),
            endsAt: new Date(Date.now() + 90_000_000).toISOString(),
            contactIds,
          }),
        ),
      );
    const alone = (await event([target.id], `Meet Wanda ${RUN}`)).event;
    const shared = (await event([target.id, other.id], `Meet Otto ${RUN}`)).event;

    const { version } = await as(a, (ctx) => crm.getContact(ctx, target.id));
    await as(a, (ctx) => crm.eraseContact(ctx, target.id, { version, confirm: 'ERASE' }));

    const events = await rows<{
      id: string;
      title: string;
      description: string | null;
      location: string | null;
      version: number;
    }>(
      sql`select id, title, description, location, version from calendar_events where id in (${alone.id}, ${shared.id})`,
    );
    expect(events.find((e) => e.id === alone.id)).toMatchObject({
      title: '—',
      description: null,
      location: null,
      version: alone.version + 1,
    });
    expect(events.find((e) => e.id === shared.id)).toMatchObject({
      title: `Meet Otto ${RUN}`,
      description: SECRET,
      version: shared.version + 1,
    });
    // nothing is logged on the erased contact's lead any more
    expect(
      await refusal(
        as(a, (ctx) => crm.logActivity(ctx, CreateActivityBody.parse({ type: 'CALL', leadId: lead.id, body: SECRET }))),
      ),
    ).toBe('CONTACT_NOT_FOUND');
    const [leadRow] = await rows<Record<string, unknown>>(
      sql`select message, visitor_name, visitor_email, visitor_phone, idempotency_hash, request_hash
            from leads where id = ${lead.id}`,
    );
    expect(leadRow).toEqual({
      message: null,
      visitor_name: null,
      visitor_email: null,
      visitor_phone: null,
      idempotency_hash: null,
      request_hash: null,
    });

    // another agency's job for this id changes nothing (RLS)
    expect(await crm.eraseContactData({ agencyId: b.agencyId, contactId: target.id })).toEqual({
      activities: 0,
      inboundLeads: 0,
      listings: 0,
    });
    const [webBefore] = await rows<{ email: string }>(sql`select email from website_leads where id = ${inboundId}`);
    expect(webBefore?.email).toBe(`wanda-web-${RUN}@example.com`);

    // the real subscription, twice: the second run changes nothing
    const results = await deliverErased(target.id, 2);
    expect(results).toEqual([
      { activities: 0, inboundLeads: 1, listings: 1 },
      { activities: 0, inboundLeads: 0, listings: 0 },
    ]);
    const [web] = await rows<Record<string, unknown>>(
      sql`select name, email, email_hash, phone, message, page_url, idempotency_hash, site_id
            from website_leads where id = ${inboundId}`,
    );
    expect(web).toEqual({
      name: '',
      email: '',
      email_hash: '',
      phone: null,
      message: null,
      page_url: null,
      idempotency_hash: null,
      site_id: siteId,
    });
    const [seller] = await rows<{ seller_contact_id: string | null }>(
      sql`select seller_contact_id from property_privates where property_id = ${dupSold.listingId}`,
    );
    expect(seller?.seller_contact_id).toBeNull();
    const completed = await rows<{ actor_kind: string; metadata: Record<string, number> }>(
      sql`select actor_kind, metadata from audit_logs where agency_id = ${a.agencyId}
            and type = 'crm.contact.erasureCompleted' and target_id = ${target.id} order by occurred_at, id`,
    );
    expect(completed.map((r) => r.metadata)).toEqual([
      { activities: 0, inboundLeads: 1, listings: 1 },
      { activities: 0, inboundLeads: 0, listings: 0 },
    ]);
    expect(completed[0]?.actor_kind).toBe('system');
  });
});
