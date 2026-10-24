import {
  CRM_ACTIVITY_LIMITS,
  CreateActivityBody,
  type CreateActivityInput,
  CreateContactBody,
  CreateLeadBody,
  CreateListingBody,
  type ListActivitiesInput,
  ListActivitiesQuery,
  UpdateListingBody,
} from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { adminQuery, setupTestDb, withAdminRollback } from '@inmolink/db/testing';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import { forgetListingActivities } from '../activities';
import * as crm from '../index';

/**
 * Activity timeline (S10-04): one partitioned table every timeline reads (contact, lead, listing, the agency's feed),
 * keyset on `(occurred_at, id)`; writers from the outbox (lead, merge, listing status), notes in their transaction,
 * calls and meetings logged by hand.
 */

const RUN = newId().slice(-8).toLowerCase();
const SEEDED = 5_000;
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('crm.activities.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

let a: Founder;
let b: Founder;
let ids: { city: string; villa: string };

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const email = (name: string) => `${name}-${RUN}@example.com`;
const contact = async (m: Founder, name: string) =>
  (await as(m, (ctx) => crm.createContact(ctx, CreateContactBody.parse({ firstName: name, emails: [email(name)] }))))
    .contact;
const timeline = (m: Founder, q: ListActivitiesInput) =>
  as(m, (ctx) => crm.listActivities(ctx, ListActivitiesQuery.parse(q)));
const log = (m: Founder, body: CreateActivityInput, opts: { idempotencyKey?: string } = {}) =>
  as(m, (ctx) => crm.logActivity(ctx, CreateActivityBody.parse(body), opts));

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

async function listing(m: Founder): Promise<string> {
  const { id } = await as(m, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.city,
        priceCents: 30_000_000,
        energyRating: 'B',
      }),
    ),
  );
  await as(m, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({ status: 'ACTIVE', version: (await properties.getListing(ctx, id)).version }),
    ),
  );
  return id;
}

/**
 * The worker's delivery of this agency's outbox events (types `types`) to crm's activity subscribers, `times` over (a
 * redelivery), with the job run in place of the queue (`crm.recordActivity`'s handler, its payload parsed).
 */
async function deliver(agencyId: string, types: readonly string[], times = 1): Promise<number> {
  const job = crm.crmJobs.recordActivity;
  const spy = vi.spyOn(job, 'enqueue').mockImplementation(async (payload) => {
    await crm.recordActivity(job.spec.payload.parse(payload));
    return { id: 'inline', added: true } as unknown as Awaited<ReturnType<typeof job.enqueue>>;
  });
  crm.registerCrmSubscriptions();
  try {
    const events = await adminQuery<{
      id: string;
      agency_id: string;
      type: string;
      version: number;
      payload: unknown;
      created_at: string;
    }>(
      `select id, agency_id, type, version, payload, created_at from outbox_events
        where agency_id = $1 and type = any($2::text[]) order by created_at, id`,
      [agencyId, types],
    );
    for (let i = 0; i < times; i++) {
      for (const row of events) {
        for (const sub of defaultSubscribers.get(row.type, row.version)) {
          if (!sub.name.startsWith('crm.activity.')) continue;
          await sub.handler(sub.def.schema.parse(row.payload), {
            eventId: row.id,
            agencyId: row.agency_id,
            type: row.type,
            version: row.version,
            createdAt: new Date(row.created_at),
            attempt: i + 1,
          });
        }
      }
    }
    return events.length;
  } finally {
    crm.unregisterCrmSubscriptions();
    spy.mockRestore();
  }
}

beforeAll(async () => {
  await setupTestDb('worker');
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const city = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `crm-ac-${RUN}`,
      translations: name('Actcountry'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `crm-ac-g-${RUN}`,
      sort: 0,
      translations: name('Homes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `crm-ac-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
}, 180_000);

afterAll(async () => {
  await closeDb();
});

describe('timeline', () => {
  it('[S10-04] timeline for a contact with 5,000 activities loads first page in < 300 ms (keyset)', async () => {
    const c = await contact(a, 'busy');
    // 5,000 activities over the last 25 days (two monthly partitions at most), every type a member logs
    await system(async (tx) => {
      await tx.execute(sql`
        insert into activities (id, agency_id, occurred_at, type, contact_id, body)
        select gen_random_uuid(), ${a.agencyId},
               date_trunc('milliseconds', now() - g * interval '7 minutes', 'UTC'),
               (array['CALL', 'EMAIL', 'MEETING', 'VIEWING', 'OTHER'])[1 + g % 5], ${c.id}, 'seeded'
        from generate_series(1, ${SEEDED}) g`);
      await tx.execute(sql`analyze activities`);
    });

    // warm the connection and the plan cache once, then time the first page and a deep page (p95 of 10 each)
    await timeline(a, { subject: 'CONTACT', subjectId: c.id, limit: 50 });
    const firstTimes: number[] = [];
    let first: Awaited<ReturnType<typeof timeline>> | undefined;
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      first = await timeline(a, { subject: 'CONTACT', subjectId: c.id, limit: 50 });
      firstTimes.push(performance.now() - t0);
    }
    firstTimes.sort((x, y) => x - y);
    expect(firstTimes[9]).toBeLessThan(300);
    expect(first?.items).toHaveLength(50);
    const at = first?.items.map((i) => i.occurredAt) ?? [];
    expect([...at].sort().reverse()).toEqual(at);

    // walk 40 pages down: each one continues exactly where the previous ended (no gaps, no repeats)
    const seen = new Set<string>(first?.items.map((i) => i.id));
    let cursor = first?.nextCursor ?? null;
    for (let p = 0; p < 40 && cursor; p++) {
      const t0 = performance.now();
      const page = await timeline(a, { subject: 'CONTACT', subjectId: c.id, limit: 50, cursor });
      expect(performance.now() - t0).toBeLessThan(300);
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      cursor = page.nextCursor;
    }
    expect(seen.size).toBe(41 * 50);

    // the type filter: only calls, newest first
    const calls = await timeline(a, { subject: 'CONTACT', subjectId: c.id, type: 'CALL', limit: 100 });
    expect(calls.items).toHaveLength(100);
    expect(new Set(calls.items.map((i) => i.type))).toEqual(new Set(['CALL']));
    const two = await timeline(a, { subject: 'CONTACT', subjectId: c.id, type: 'CALL,EMAIL', limit: 100 });
    expect(new Set(two.items.map((i) => i.type))).toEqual(new Set(['CALL', 'EMAIL']));

    // another agency sees none of it: its contact lookup refuses, its feed and a listing filter hold nothing of a's
    expect(await refusal(timeline(b, { subject: 'CONTACT', subjectId: c.id }))).toBe('CONTACT_NOT_FOUND');
    const feed = await timeline(b, { limit: 100 });
    expect(feed.items.filter((i) => i.contactId === c.id)).toEqual([]);
  }, 120_000);

  it('[S10-04] the timeline lists are index conditions under RLS on every partition, deep pages included', async () => {
    // A contact with 5,000 activities among 200 agencies' (60k rows over the last 25 days); FK checks off in this rolled-back
    // seed; analysed, EXPLAINed as app_user (RLS on).
    const contactId = newId();
    const leadId = newId();
    const listingId = newId();
    const plans = await withAdminRollback(['activities'], async (q) => {
      await q('set local session_replication_role = replica');
      await q(
        `insert into activities (id, agency_id, occurred_at, type, contact_id, lead_id, listing_id)
         select gen_random_uuid(), $1, date_trunc('milliseconds', now() - g * interval '7 minutes', 'UTC'),
                case when g % 10 = 0 then 'LEAD_UPDATED' else 'CALL' end, $2,
                case when g % 4 = 0 then $3::uuid end, case when g % 7 = 0 then $4::uuid end
         from generate_series(1, 5000) g`,
        [a.agencyId, contactId, leadId, listingId],
      );
      await q(
        `insert into activities (id, agency_id, occurred_at, type, contact_id)
         select gen_random_uuid(), ag.id, date_trunc('milliseconds', now() - (g * 37 % 25) * interval '1 day', 'UTC'),
                'CALL', gen_random_uuid()
         from (select gen_random_uuid() as id from generate_series(1, 200)) ag, generate_series(1, 275) g`,
      );
      await q('analyze activities');
      const filled = (await q(`select distinct tableoid::regclass::text as p from activities`)).map((r) => String(r.p));
      await q('set local role app_user');
      await q(`select set_config('app.agency_id', $1, true)`, [a.agencyId]);
      const explain = async (text: string, values: unknown[]) => {
        const out = await q(`explain ${text}`, values);
        return out.map((r) => String(Object.values(r)[0])).join('\n');
      };
      const deep = `and occurred_at <= now() - interval '17500 minutes'
        and (occurred_at, id) < (now() - interval '17500 minutes', 'ffffffff-ffff-7fff-bfff-ffffffffffff'::uuid)`;
      const order = 'order by occurred_at desc, id desc limit 51';
      const of = (extra: string, cursor = '') =>
        `select id, type, occurred_at from activities where agency_id = $1 ${extra} ${cursor} ${order}`;
      return {
        filled,
        contactFirst: await explain(of('and contact_id = $2'), [a.agencyId, contactId]),
        contactDeep: await explain(of('and contact_id = $2', deep), [a.agencyId, contactId]),
        contactType: await explain(of(`and contact_id = $2 and type = any($3::text[])`, deep), [
          a.agencyId,
          contactId,
          ['LEAD_UPDATED'],
        ]),
        lead: await explain(of('and lead_id = $2', deep), [a.agencyId, leadId]),
        listing: await explain(of('and listing_id = $2', deep), [a.agencyId, listingId]),
        feed: await explain(of('', deep), [a.agencyId]),
        feedType: await explain(of('and type = any($2::text[])', deep), [a.agencyId, ['LEAD_UPDATED']]),
      };
    });
    const index = {
      contactFirst: /activities_p\w+_agency_id_contact_id_occurred_at_id_idx/,
      contactDeep: /activities_p\w+_agency_id_contact_id_occurred_at_id_idx/,
      // one type of one contact: its subject index, or the agency's type index when that type is mostly this contact's
      contactType: /activities_p\w+_agency_id_(contact_id|type)_occurred_at_id_idx/,
      lead: /activities_p\w+_agency_id_lead_id_occurred_at_id_idx/,
      listing: /activities_p\w+_agency_id_listing_id_occurred_at_id_idx/,
      feed: /activities_p\w+_agency_id_occurred_at_id_idx/,
      feedType: /activities_p\w+_agency_id_type_occurred_at_id_idx/,
    } as const;
    const { filled, ...lists } = plans;
    expect(filled.length).toBeGreaterThanOrEqual(1);
    for (const [name, text] of Object.entries(lists)) {
      expect(text, name).toMatch(index[name as keyof typeof index]);
      const lines = text.split('\n');
      // every month holding rows is read through the subject's index (an empty month may be "scanned" for free)
      for (const part of filled) {
        const scans = lines.flatMap((l, i) => (l.includes(` on ${part} `) ? [i] : []));
        expect(scans.length, `${name} ${part}`).toBeGreaterThanOrEqual(1);
        for (const i of scans) {
          expect(lines[i], `${name} ${part}`).toMatch(/Index (Only )?Scan/);
          if (name === 'contactFirst') continue;
          // the cursor is an index condition (RLS on: a plain column's row comparison is leakproof), never a Filter
          expect(lines[i + 1], `${name} ${part}`).toMatch(/Index Cond: .*ROW\(occurred_at, id\) </);
          expect(lines[i + 2] ?? '', `${name} ${part}`).not.toMatch(/Filter: .*ROW\(occurred_at/);
        }
      }
      // the 5,000-activity contact: newest first straight from the indexes (a merge of each month's ordered scan), never
      // a sort of its rows (a small match — a lead's 1,250, one type deep down — may be sorted after the index scan)
      if (name === 'contactFirst' || name === 'contactDeep') expect(text, name).not.toMatch(/\bSort\b/);
    }
  }, 120_000);
});

describe('writers', () => {
  it('[S10-04] leads, merges and listing status changes reach the timelines through the outbox, once', async () => {
    const survivor = await contact(a, 'writer');
    const duplicate = await contact(a, 'writer-old');
    const listingId = await listing(a);
    const { lead } = await as(a, (ctx) =>
      crm.createLead(ctx, CreateLeadBody.parse({ contactId: survivor.id, target: { kind: 'LISTING', id: listingId } })),
    );
    // S10-03: a status is a stage change (STAGE_CHANGED); the assignment is LEAD_UPDATED
    await as(a, (ctx) =>
      crm.updateLead(ctx, lead.id, { version: lead.version, status: 'IN_PROGRESS', assignedUserId: a.userId }),
    );
    // the duplicate's own lead: the merge re-points it (a new version) without a crm.lead.updated
    const { lead: dupLead } = await as(a, (ctx) =>
      crm.createLead(ctx, CreateLeadBody.parse({ contactId: duplicate.id })),
    );
    // astral characters: the excerpt is cut on whole characters, never half a surrogate pair
    const note = await as(a, (ctx) =>
      crm.addContactNote(ctx, duplicate.id, { body: `${'x'.repeat(279)}${'😀'.repeat(30)}` }),
    );
    const call = (await log(a, { type: 'CALL', contactId: duplicate.id, body: 'Asked for the floor plan' })).activity;
    await as(a, (ctx) => crm.mergeContacts(ctx, survivor.id, { duplicateId: duplicate.id, version: survivor.version }));

    const types = [
      'crm.lead.created',
      'crm.lead.updated',
      'crm.lead.stageChanged',
      'crm.contact.merged',
      'properties.listing.statusChanged',
    ];
    const delivered = await deliver(a.agencyId, types, 2);
    expect(delivered).toBeGreaterThanOrEqual(5);

    const ofContact = await timeline(a, { subject: 'CONTACT', subjectId: survivor.id, limit: 100 });
    const byType = (items: { type: string }[]) => items.map((i) => i.type).sort();
    // twice delivered, recorded once; the duplicate's note and call moved with the merge
    // (the duplicate's lead moved with it: its LEAD_CREATED, and no LEAD_UPDATED from the merge)
    expect(byType(ofContact.items)).toEqual(
      ['CALL', 'CONTACT_MERGED', 'LEAD_CREATED', 'LEAD_CREATED', 'LEAD_UPDATED', 'NOTE_ADDED', 'STAGE_CHANGED'].sort(),
    );
    const byKind = Object.fromEntries(ofContact.items.map((i) => [i.type, i]));
    expect(byKind.CONTACT_MERGED?.data).toEqual({ mergedId: duplicate.id });
    const created = ofContact.items.filter((i) => i.type === 'LEAD_CREATED');
    expect(created.find((i) => i.leadId === lead.id)).toMatchObject({ listingId, data: { source: 'MANUAL' } });
    expect(created.find((i) => i.leadId === dupLead.id)).toMatchObject({ contactId: survivor.id, listingId: null });
    expect(byKind.LEAD_UPDATED).toMatchObject({ leadId: lead.id, data: { assignedUserId: a.userId } });
    expect(byKind.STAGE_CHANGED).toMatchObject({ leadId: lead.id, listingId, data: { status: 'IN_PROGRESS' } });
    const dupUpdates = await rows<{ n: number }>(
      sql`select count(*)::int as n from outbox_events
          where type = 'crm.lead.updated' and payload->>'leadId' = ${dupLead.id}`,
    );
    expect(dupUpdates[0]?.n).toBe(0);
    expect(byKind.NOTE_ADDED).toMatchObject({ actorUserId: a.userId, data: { noteId: note.id } });
    expect(byKind.NOTE_ADDED?.body).toBe(`${'x'.repeat(279)}😀`);
    expect(Array.from(byKind.NOTE_ADDED?.body ?? '')).toHaveLength(crm.NOTE_EXCERPT_CHARS);
    expect(byKind.CALL?.id).toBe(call.id);

    const ofLead = await timeline(a, { subject: 'LEAD', subjectId: lead.id });
    expect(byType(ofLead.items)).toEqual(['LEAD_CREATED', 'LEAD_UPDATED', 'STAGE_CHANGED']);
    const ofListing = await timeline(a, { subject: 'LISTING', subjectId: listingId });
    expect(byType(ofListing.items)).toEqual([
      'LEAD_CREATED',
      'LEAD_UPDATED',
      'LISTING_STATUS_CHANGED',
      'STAGE_CHANGED',
    ]);
    const status = ofListing.items.find((i) => i.type === 'LISTING_STATUS_CHANGED');
    expect(status?.data).toEqual({ from: 'DRAFT', to: 'ACTIVE' });
    const filtered = await timeline(a, { subject: 'LISTING', subjectId: listingId, type: 'LISTING_STATUS_CHANGED' });
    expect(filtered.items.map((i) => i.id)).toEqual([status?.id]);

    // one row per event, whatever the deliveries
    const perEvent = await rows<{ n: number }>(
      sql`select count(*)::int as n from activities where agency_id = ${a.agencyId} and event_id is not null
          group by event_id having count(*) > 1`,
    );
    expect(perEvent).toEqual([]);
  });

  it('[S10-04] a purged listing leaves the timelines: its own activities go, a lead keeps its row without it', async () => {
    const c = await contact(a, 'purge');
    const listingId = await listing(a);
    const own = (await log(a, { type: 'VIEWING', listingId })).activity;
    const shared = (await log(a, { type: 'CALL', listingId, contactId: c.id })).activity;
    // the subscription queues one job per purge event (the job run in place of the queue), delivered twice
    const job = crm.crmJobs.forgetListingActivities;
    const spy = vi.spyOn(job, 'enqueue').mockImplementation(async (payload) => {
      await forgetListingActivities(job.spec.payload.parse(payload));
      return { id: 'inline', added: true } as unknown as Awaited<ReturnType<typeof job.enqueue>>;
    });
    crm.registerCrmSubscriptions();
    try {
      const [sub] = defaultSubscribers
        .get('properties.listing.purged', 1)
        .filter((s) => s.name === 'crm.activity.listingPurged');
      expect(sub).toBeDefined();
      const meta = { eventId: newId(), agencyId: a.agencyId, type: 'properties.listing.purged', version: 1 };
      for (const attempt of [1, 2]) {
        await sub?.handler({ listingId, agencyId: a.agencyId }, { ...meta, createdAt: new Date(), attempt });
      }
    } finally {
      crm.unregisterCrmSubscriptions();
      spy.mockRestore();
    }
    expect((await timeline(a, { subject: 'LISTING', subjectId: listingId })).items).toEqual([]);
    const ofContact = await timeline(a, { subject: 'CONTACT', subjectId: c.id });
    expect(ofContact.items.map((i) => [i.id, i.listingId])).toEqual([[shared.id, null]]);
    expect(await rows(sql`select 1 from activities where id = ${own.id}`)).toEqual([]);
  });

  it('[S10-04] an event no month can hold fails once, non-retryable, with its id; backdating stays in kept months', async () => {
    // partitions are made 4 months back and ahead and never dropped (no retention): a logged activity, at most
    // `backdateDays` old, always has its month
    expect(CRM_ACTIVITY_LIMITS.backdateDays).toBeLessThanOrEqual(31);
    const eventId = newId();
    const err = await crm
      .recordActivity({
        eventId,
        agencyId: a.agencyId,
        occurredAt: '2020-01-15T10:00:00.000Z',
        type: 'LISTING_STATUS_CHANGED',
        listingId: newId(),
        data: { from: 'DRAFT', to: 'ACTIVE' },
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isAppError(err)).toBe(true);
    if (isAppError(err)) {
      expect(err.retryable).toBe(false);
      expect(err.details).toMatchObject({ eventId });
    }
  });

  it('[S10-04] a logged activity: lead fills its contact, Idempotency-Key replays the same body only, dates bounded', async () => {
    const c = await contact(a, 'logger');
    const { lead } = await as(a, (ctx) => crm.createLead(ctx, CreateLeadBody.parse({ contactId: c.id })));
    const key = `act-key-${RUN}-0001`;
    const first = await log(a, { type: 'MEETING', leadId: lead.id, body: 'Office visit' }, { idempotencyKey: key });
    expect(first.replayed).toBe(false);
    expect(first.activity).toMatchObject({ type: 'MEETING', leadId: lead.id, contactId: c.id, actorUserId: a.userId });
    const again = await log(a, { type: 'MEETING', leadId: lead.id, body: 'Office visit' }, { idempotencyKey: key });
    expect(again).toEqual({ activity: first.activity, replayed: true });
    expect(await refusal(log(a, { type: 'MEETING', leadId: lead.id, body: 'Other' }, { idempotencyKey: key }))).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    const ofContact = await timeline(a, { subject: 'CONTACT', subjectId: c.id });
    expect(ofContact.items.filter((i) => i.type === 'MEETING').map((i) => i.id)).toEqual([first.activity.id]);

    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    expect((await log(a, { type: 'CALL', contactId: c.id, occurredAt: yesterday })).activity.occurredAt).toBe(
      yesterday,
    );
    const tooOld = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const ahead = new Date(Date.now() + 3_600_000).toISOString();
    expect(await refusal(log(a, { type: 'CALL', contactId: c.id, occurredAt: tooOld }))).toBe(
      'ACTIVITY_DATE_OUT_OF_RANGE',
    );
    expect(await refusal(log(a, { type: 'CALL', contactId: c.id, occurredAt: ahead }))).toBe(
      'ACTIVITY_DATE_OUT_OF_RANGE',
    );
    // another agency's contact, lead or listing is refused; no subject is a validation error
    expect(await refusal(log(b, { type: 'CALL', contactId: c.id }))).toBe('CONTACT_NOT_FOUND');
    expect(await refusal(log(b, { type: 'CALL', leadId: lead.id }))).toBe('LEAD_NOT_FOUND');
    const aListing = await listing(a);
    expect(await refusal(log(b, { type: 'CALL', listingId: aListing }))).toBe('LISTING_NOT_FOUND');
    // a lead's activity is about the lead's client: another contact is refused
    const other = await contact(a, 'logger-other');
    expect(await refusal(log(a, { type: 'CALL', leadId: lead.id, contactId: other.id }))).toBe('VALIDATION_FAILED');
    expect((await log(a, { type: 'CALL', leadId: lead.id, contactId: c.id })).activity.contactId).toBe(c.id);
    expect(CreateActivityBody.safeParse({ type: 'CALL' }).success).toBe(false);
    expect(CreateActivityBody.safeParse({ type: 'NOTE_ADDED', contactId: c.id }).success).toBe(false);
  });

  it('[S10-04] nothing of the timeline is open in Client Mode; a subject needs its id', async () => {
    const client = <T>(fn: (ctx: Ctx) => Promise<T>) => as(a, (ctx) => fn({ ...ctx, clientMode: true }));
    expect(await refusal(client((ctx) => crm.listActivities(ctx, ListActivitiesQuery.parse({}))))).toBe('FORBIDDEN');
    const c = await contact(a, 'cm');
    expect(
      await refusal(client((ctx) => crm.logActivity(ctx, CreateActivityBody.parse({ type: 'CALL', contactId: c.id })))),
    ).toBe('FORBIDDEN');
    expect(ListActivitiesQuery.safeParse({ subject: 'CONTACT' }).success).toBe(false);
  });
});
