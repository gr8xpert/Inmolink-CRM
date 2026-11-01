import {
  ListActivitiesQuery,
  ListCalendarEventsQuery,
  ListContactsQuery,
  ListLeadsQuery,
  ListNotificationsQuery,
  ListTasksQuery,
  NOTIFICATION_TYPES,
  PipelineBoardQuery,
} from '@inmolink/contracts';
import { withMemberCtx } from '@inmolink/core';
import * as crm from '@inmolink/core/modules/crm';
import * as matching from '@inmolink/core/modules/matching';
import * as notifications from '@inmolink/core/modules/notifications';
import { closeDb, withSystem } from '@inmolink/db';
import { users } from '@inmolink/db/schema/identity';
import { adminQuery, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALENDAR_WEEKS, CALENDAR_WEEKS_BEFORE, seedAnchor, seededContactId } from '../../scripts/seed/crm';
import { DEFAULT_FEED_BASE_URL, feedConnectionsOf, SEEDED_FEED_NAME, seededFeedUrl } from '../../scripts/seed/imports';
import { PER_AGENCY, scaleCounts } from '../../scripts/seed/profile';
import { seededId } from '../../scripts/seed/rng';
import { DEFAULT_DEMO_PASSWORD, runScaleSeed } from '../../scripts/seed/run';
import { removeSeededTaxonomy } from '../../scripts/seed/taxonomy';
import { removeSeededLoadData } from './cleanup';

// A seed no other suite uses (913: seed.int, 914/916: the perf seed), so its rows are this file's alone.
const SEED = 917;
const AGENCIES = 6;
const FEED_BASE = 'https://feeds.load.example';
/** Today's seed day, shared by every seed run in this file (so a re-run and a fresh run place the same rows). */
const ANCHOR = seedAnchor(new Date());
const DAY = 86_400_000;
const scaleDomain = `%@s${SEED}.scale.inmolink.test`;
const agencyIds = Array.from({ length: AGENCIES }, (_, a) => seededId(SEED, 'agencies', a));
const ids = `{${agencyIds.join(',')}}`;

const scale = (chunk: number) =>
  runScaleSeed({
    agencies: AGENCIES,
    seed: SEED,
    chunk,
    scalePassword: DEFAULT_DEMO_PASSWORD,
    feedBaseUrl: FEED_BASE,
    anchor: ANCHOR,
  });

const cleanup = async () => {
  await removeSeededLoadData(SEED, AGENCIES);
  await withSystem('test.seed.cleanup', async (tx) => {
    await tx.execute(sql`delete from properties where agency_id = any(${ids}::uuid[])`);
    await tx.delete(users).where(like(users.email, scaleDomain));
  });
  await removeSeededTaxonomy(SEED);
};

/**
 * Per table, the seeded agencies' rows and a digest of their content (`to_jsonb` of each row, in id order) —
 * determinism without dumping the rows. `lead_stage_history` gets its ids from the trigger: hashed without them.
 */
async function fingerprint(): Promise<Record<string, { n: number; digest: string }>> {
  const tables = [
    'feed_connections',
    'saved_searches',
    'pipeline_stages',
    'contacts',
    'contact_emails',
    'contact_phones',
    'leads',
    'lead_stage_history',
    'activities',
    'tasks',
    'calendar_events',
    'calendar_event_attendees',
    'notifications',
    'notification_preferences',
  ];
  const out: Record<string, { n: number; digest: string }> = {};
  for (const t of tables) {
    const row = t === 'lead_stage_history' ? `to_jsonb(r) - 'id'` : 'to_jsonb(r)';
    const order =
      t === 'lead_stage_history'
        ? 'r.lead_id, r.to_stage_id'
        : t === 'notification_preferences'
          ? 'r.user_id, r.type'
          : 'r.id';
    const [r] = await adminQuery<{ n: number; digest: string }>(
      `select count(*)::int as n, md5(coalesce(string_agg((${row})::text, ',' order by ${order}), '')) as digest
         from ${t} r where r.agency_id = any($1::uuid[])`,
      [agencyIds],
    );
    out[t] = r ?? { n: 0, digest: '' };
  }
  return out;
}

let first: Awaited<ReturnType<typeof scale>>;

beforeAll(async () => {
  await setupTestDb('script');
  await cleanup();
  first = await scale(100);
  // keep the agencies from another suite's stale-agency prune (seeded rows are dated 2026-01-01) while this file runs
  await adminQuery('update agencies set updated_at = now() where agency_id = any($1::uuid[])', [agencyIds]);
}, 300_000);
afterAll(async () => {
  await cleanup();
  await closeDb();
}, 300_000);

describe('S16-F4 scale seed: the load suite data', () => {
  it('[S16-F4] at 5,000 agencies the profile is 5,000 feed connections, 1M client profiles and 10M contacts', () => {
    expect(scaleCounts(5_000)).toMatchObject({
      feedConnections: 5_000,
      clientProfiles: 1_000_000,
      contacts: 10_000_000,
      leads: 2_000_000,
      tasks: 750_000,
      activities: 14_000_000,
      calendarEvents: 1_200_000,
      notifications: 1_250_000,
    });
    const connections = feedConnectionsOf(SEED, AGENCIES).reduce((n, c) => n + c, 0);
    expect(first.results['imports.feed_connections']).toMatchObject({ inserted: connections, total: connections });
    expect(first.results['matching.saved_searches']).toMatchObject({ total: AGENCIES * PER_AGENCY.clientProfiles });
    expect(first.results['crm.contacts']).toMatchObject({ total: AGENCIES * PER_AGENCY.contacts });
    expect(first.results['notifications.notifications']).toMatchObject({ total: AGENCIES * PER_AGENCY.notifications });
  });

  it('[S16-F4] Kyero feed connections at the seed-time host, off (the scheduler never picks one): one per agency, 8 or 2 for the acceptance storm multi-feed tenants', async () => {
    const rows = await adminQuery<{
      id: string;
      agency_id: string;
      connector: string;
      url: string;
      due: boolean;
      name: string;
    }>(
      `select id, agency_id, connector, url, name,
              (enabled and next_run_at is not null and paused_at is null) as due
         from feed_connections where agency_id = any($1::uuid[])`,
      [agencyIds],
    );
    const per = feedConnectionsOf(SEED, AGENCIES);
    expect(rows).toHaveLength(per.reduce((n, c) => n + c, 0));
    for (const [a, id] of agencyIds.entries()) {
      const mine = rows.filter((r) => r.agency_id === id).sort((x, y) => x.url.localeCompare(y.url));
      expect(mine.map(({ id: _, ...r }) => r)).toEqual(
        Array.from({ length: per[a] as number }, (_, i) => ({
          agency_id: id,
          connector: 'kyero',
          url: seededFeedUrl(FEED_BASE, SEED, a, i),
          name: SEEDED_FEED_NAME,
          due: false,
        })).sort((x, y) => x.url.localeCompare(y.url)),
      );
    }
    // the first VERIFIED agencies hold the 8-feed tenants' connections (this seed: every verified one of the 6)
    expect(per.filter((n) => n === 8).length).toBeGreaterThan(0);
    // no real host by default
    expect(new URL(seededFeedUrl(DEFAULT_FEED_BASE_URL, SEED, 0)).hostname.endsWith('.invalid')).toBe(true);
  });

  it('[S16-F4] 200 DAILY client profiles per agency, 40 per member, keyed by matching.searchKeys', async () => {
    const rows = await adminQuery<{
      agency_id: string;
      user_id: string;
      scope: string;
      frequency: string;
      transaction_type: string | null;
      location_ids: string[];
      match_keys: string[];
      open: boolean;
    }>(
      `select s.agency_id, s.user_id, s.scope, s.frequency, s.transaction_type, s.location_ids::text[] as location_ids,
              s.match_keys, a.status = 'VERIFIED' as open
         from saved_searches s join agencies a on a.agency_id = s.agency_id
        where s.agency_id = any($1::uuid[])`,
      [agencyIds],
    );
    expect(rows).toHaveLength(AGENCIES * 200);
    expect(new Set(rows.map((r) => r.frequency))).toEqual(new Set(['DAILY']));
    const perUser = new Map<string, number>();
    for (const r of rows) perUser.set(r.user_id, (perUser.get(r.user_id) ?? 0) + 1);
    expect([...perUser.values()].every((n) => n === 40)).toBe(true);
    expect(new Set(rows.map((r) => r.scope))).toEqual(new Set(['OWN', 'NETWORK', 'ALL']));
    for (const r of rows) {
      expect(r.match_keys).toEqual(
        matching.searchKeys(
          { agencyId: r.agency_id, scope: r.scope, transactionType: r.transaction_type, locationIds: r.location_ids },
          r.open,
        ),
      );
    }
    // a place of the seeded tree for most network searches
    const placed = rows.filter((r) => r.scope !== 'OWN' && r.location_ids.length > 0).length;
    expect(placed).toBe(rows.filter((r) => r.scope !== 'OWN').length);
  });

  it('[S16-F4] 2,000 contacts per agency with their identifiers and facets; leads, activities, tasks and a calendar in the PER_AGENCY ratios', async () => {
    const [c] = await adminQuery<Record<string, number>>(
      `select (select count(*)::int from contacts where agency_id = any($1::uuid[])) as contacts,
              (select count(*)::int from contacts c where agency_id = any($1::uuid[]) and (
                 (primary_email is not null) <> exists (select 1 from contact_emails e where e.contact_id = c.id)
                 or (primary_phone is not null) <> exists (select 1 from contact_phones p where p.contact_id = c.id)
                 or cardinality(types) <> (select count(*) from contact_facets f where f.contact_id = c.id))) as bad_identifiers,
              (select count(*)::int from leads where agency_id = any($1::uuid[])) as leads,
              (select count(*)::int from leads l join pipeline_stages s on s.id = l.stage_id
                where l.agency_id = any($1::uuid[]) and s.status <> l.status) as bad_stage,
              (select count(*)::int from lead_stage_history where agency_id = any($1::uuid[])) as history,
              (select count(*)::int from activities where agency_id = any($1::uuid[])) as activities,
              (select count(*)::int from contacts c where agency_id = any($1::uuid[])
                 and not exists (select 1 from activities a where a.agency_id = c.agency_id and a.contact_id = c.id)) as no_timeline,
              (select count(*)::int from tasks where agency_id = any($1::uuid[])) as tasks,
              (select count(*)::int from tasks where agency_id = any($1::uuid[]) and remind) as reminding,
              (select count(*)::int from calendar_events where agency_id = any($1::uuid[])) as events,
              (select count(*)::int from calendar_events where agency_id = any($1::uuid[]) and remind_at is not null) as event_reminders,
              (select count(*)::int from calendar_events where agency_id = any($1::uuid[])
                 and (starts_at < $2::timestamptz or starts_at >= $3::timestamptz)) as outside,
              (select count(*)::int from notifications where agency_id = any($1::uuid[])) as notifications,
              (select count(*)::int from notifications where agency_id = any($1::uuid[]) and read_at is null) as unread,
              (select count(*)::int from notifications where agency_id = any($1::uuid[]) and email_pending) as digest,
              (select count(*)::int from leads where agency_id = any($1::uuid[])
                 and (first_human_response_at > $4::timestamptz or stage_entered_at > $4::timestamptz)) as answered_late,
              (select count(*)::int from activities a join leads l on l.id = a.lead_id
                where a.agency_id = any($1::uuid[]) and (a.occurred_at < l.created_at or a.occurred_at > $4::timestamptz)) as lead_activity_outside,
              (select count(*)::int from notifications n join leads l on n.link = '/inbox/' || l.id::text
                where n.agency_id = any($1::uuid[]) and l.assigned_user_id is distinct from n.user_id) as foreign_lead_links,
              (select count(*)::int from notifications where agency_id = any($1::uuid[]) and type = 'LEAD_ASSIGNED') as lead_notices,
              (select count(*)::int from notification_preferences where agency_id = any($1::uuid[]) and not email and in_app and enabled) as email_off`,
      [
        agencyIds,
        new Date(ANCHOR.getTime() - CALENDAR_WEEKS_BEFORE * 7 * DAY),
        new Date(ANCHOR.getTime() + (CALENDAR_WEEKS - CALENDAR_WEEKS_BEFORE) * 7 * DAY),
        ANCHOR,
      ],
    );
    expect(c).toMatchObject({
      contacts: AGENCIES * 2_000,
      bad_identifiers: 0,
      leads: AGENCIES * 400,
      bad_stage: 0,
      history: AGENCIES * 400,
      activities: AGENCIES * 2_800,
      no_timeline: 0,
      tasks: AGENCIES * 150,
      reminding: 0,
      events: AGENCIES * 240,
      event_reminders: 0,
      outside: 0,
      notifications: AGENCIES * 250,
      digest: 0,
      // answered and moved before the seed day; a lead's activities between its arrival and the seed day
      answered_late: 0,
      lead_activity_outside: 0,
      // a lead assignment links a lead of its own member
      foreign_lead_links: 0,
      // every seeded member: e-mail off for every type (no digest or alert reaches a synthetic address)
      email_off: AGENCIES * PER_AGENCY.users * NOTIFICATION_TYPES.length,
    });
    expect(c?.lead_notices).toBeGreaterThan(0);
    expect(c?.unread).toBeGreaterThan(AGENCIES * 250 * 0.3);
    expect(c?.unread).toBeLessThan(AGENCIES * 250 * 0.5);
  });

  it('[S16-F4] an agent sees non-empty CRM pages through the services the dashboard routes call', async () => {
    // agency 1, its first agent (u1): the member perf:load:tokens picks first
    const agencyId = agencyIds[1] as string;
    const userId = seededId(SEED, 'identity.users:1', 1);
    const from = new Date(Math.floor(Date.now() / DAY) * DAY);
    const pages = await withMemberCtx({ userId, agencyId, requestId: newId(), locale: 'en' }, async (ctx) => ({
      contacts: (await crm.listContacts(ctx, ListContactsQuery.parse({ owner: 'me', limit: 25 }))).items.length,
      timeline: (
        await crm.listActivities(
          ctx,
          ListActivitiesQuery.parse({ subject: 'CONTACT', subjectId: seededContactId(SEED, 1, 1), limit: 25 }),
        )
      ).items.length,
      activities: (await crm.listActivities(ctx, ListActivitiesQuery.parse({ limit: 25 }))).items.length,
      board: (await crm.getPipelineBoard(ctx, PipelineBoardQuery.parse({ assigned: 'me' }))).columns.reduce(
        (n, col) => n + col.items.length,
        0,
      ),
      leads: (await crm.listLeads(ctx, ListLeadsQuery.parse({ assigned: 'me', limit: 25 }))).items.length,
      tasks: (await crm.listTasks(ctx, ListTasksQuery.parse({ assignee: 'me', status: 'OPEN', limit: 25 }))).items
        .length,
      calendar: (
        await crm.listCalendarEvents(
          ctx,
          ListCalendarEventsQuery.parse({
            from: from.toISOString(),
            to: new Date(from.getTime() + 7 * DAY).toISOString(),
            limit: 100,
          }),
        )
      ).items.length,
      notifications: (await notifications.listNotifications(ctx, ListNotificationsQuery.parse({ limit: 25 }))).items
        .length,
      unread: (await notifications.listNotifications(ctx, ListNotificationsQuery.parse({ unread: 'true', limit: 25 })))
        .items.length,
      savedSearches: (await matching.listSavedSearches(ctx)).items.length,
    }));
    for (const [page, n] of Object.entries(pages)) expect({ page, n: n > 0 }).toEqual({ page, n: true });
  });

  it('[S16-F4] re-running the seed writes nothing; the rows are the same whatever the chunk size', async () => {
    const before = await fingerprint();
    const again = await scale(1);
    for (const name of [
      'imports.feed_connections',
      'matching.saved_searches',
      'crm.contacts',
      'notifications.notifications',
    ]) {
      expect(again.results[name]?.inserted, name).toBe(0);
    }
    expect(await fingerprint()).toEqual(before);

    // from scratch with another chunk size: the same rows
    await removeSeededLoadData(SEED, AGENCIES);
    const fresh = await scale(1);
    expect(fresh.results['crm.contacts']?.inserted).toBe(AGENCIES * 2_000);
    expect(await fingerprint()).toEqual(before);
  }, 300_000);
});
