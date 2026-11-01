import { PIPELINE_STAGE_KEYS, type PipelineStageKey } from '@inmolink/contracts';
import { timeRank } from '@inmolink/core/modules/crm';
import { withSystem, withSystemClient } from '@inmolink/db';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { type CopyValue, copyRows, forEachChunk } from './copy';
import { SEEDED_AT } from './identity';
import { listingsOf, seededListingId } from './listings';
import { PER_AGENCY } from './profile';
import { createRng, type Rng, seededId } from './rng';
import type { Seeder } from './seeders';

/**
 * The CRM for the scale seed (S16-F4, PLAN §4.1 "2,000 contacts" per agency, §15 10M): contacts with their e-mails,
 * phones and list facets; the default pipeline; leads (one contact in five) in its stages; one activity per contact and
 * two more per lead; tasks; and calendar events with their attendees — what the dashboard load test's CRM pages read
 * (`tests/load/lib/dashboard-mix.ts`). Ratios: `PER_AGENCY` (the non-§4.1 ones are this seed's assumption).
 *
 * Every row is written as the services would leave it: types mirrored into `contact_facets`, a lead's status its
 * stage's (the `leads_stage_guard` trigger checks; `leads_stage_history` writes the first stay), member references to
 * the agency's seeded members, times to the millisecond. Nothing reminds or e-mails: tasks have `remind` off, events
 * no reminder. Time-windowed rows sit around the seed day (`anchor`, start of today UTC by default) — a contact's
 * activity in the 60 days before it, a lead's between its arrival (≤ 100 days back) and it, lead answers before it
 * (their monthly partitions exist: pg_partman keeps the 4 months before), calendar events from 4 weeks before to 12
 * after (the dashboard load test asks for a week inside that span), task due dates around it.
 * Rollups the reports read (`crm_stage_counts`, …) are not written: the worker rebuilds them from the first lead event.
 *
 * COPY per chunk of `CRM_AGENCIES_PER_CHUNK` agencies (~11k rows each), deterministic per seed, idempotent per agency
 * (an agency's rows are one transaction: a chunk skips the agencies whose first or last contact or last lead exists,
 * and COPYs the rest
 * without a per-row check). Pipeline stages are an `insert … on conflict do nothing` (5 per agency): an agency the
 * crm service already gave stages keeps them, and its leads go into those.
 */

/** Agencies per transaction: ~11k CRM rows each, so a chunk stays near 45k rows whatever `--chunk` says. */
export const CRM_AGENCIES_PER_CHUNK = 4;
/** Calendar events lie in `[anchor - CALENDAR_WEEKS_BEFORE weeks, + CALENDAR_WEEKS)`. */
export const CALENDAR_WEEKS = 16;
export const CALENDAR_WEEKS_BEFORE = 4;
/** Activities lie in the days before the anchor (inside the partitions pg_partman keeps). */
export const ACTIVITY_DAYS = 60;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;

/** The start of the anchor's UTC day: the seed's time-relative rows are placed around it. */
export function seedAnchor(anchor: Date = new Date()): Date {
  return new Date(Math.floor(anchor.getTime() / DAY) * DAY);
}

export const seededContactId = (seed: number, a: number, i: number) => seededId(seed, `crm.contacts:${a}`, i);
export const seededLeadId = (seed: number, a: number, j: number) => seededId(seed, `crm.leads:${a}`, j);
const seededStageId = (seed: number, a: number, k: number) => seededId(seed, `crm.pipeline_stages:${a}`, k);
/** Leads `j` with `j % 10 === LEAD_UNASSIGNED` are new and unassigned; every other lead is `user(j % users)`'s. */
export const LEAD_UNASSIGNED = 9;
/** The contact a lead is for: one contact in five. */
export const LEAD_EVERY = PER_AGENCY.contacts / PER_AGENCY.leads;
/** Reserved for documentation (RFC 2606): never a real mailbox. */
export const contactEmail = (seed: number, a: number, i: number) => `c${i}@a${a}.s${seed}.contacts.inmolink.test`;
/** Spanish mobile range, unique per agency (the duplicate check is per agency). */
export const contactPhone = (i: number) => `+3460${String(i).padStart(7, '0')}`;

const FIRST = ['Lucía', 'Hugo', 'Martina', 'Mateo', 'Sofía', 'Leo', 'Emma', 'Daniel', 'Julia', 'Pablo', 'Anna', 'Lars'];
const LAST = ['García', 'Martínez', 'López', 'Sánchez', 'Romero', 'Navarro', 'Smith', 'de Vries', 'Johansson'];
const LANGUAGES = ['en', 'en', 'es', 'es', 'de', 'nl', 'sv', 'fr'];
const CONTACT_SOURCES = ['WEBSITE', 'WEBSITE', 'WEBSITE', 'PORTAL', 'PORTAL', 'MANUAL', 'REFERRAL', 'PHONE', 'WALK_IN'];
const LEAD_SOURCES = ['WEBSITE', 'WEBSITE', 'WEBSITE', 'PORTAL', 'PORTAL', 'MANUAL', 'WHATSAPP', 'CHATBOT'];
type Stage = PipelineStageKey;
const MANUAL_TYPES = ['CALL', 'CALL', 'EMAIL', 'EMAIL', 'EMAIL', 'MEETING', 'VIEWING', 'OTHER'] as const;
const ACTIVITY_BODY: Record<(typeof MANUAL_TYPES)[number], string> = {
  CALL: 'Called about the budget and the areas they like.',
  EMAIL: 'Sent a shortlist of matching properties.',
  MEETING: 'Met at the office to go through the options.',
  VIEWING: 'Viewing done; liked the terrace, unsure about the price.',
  OTHER: 'Updated the search criteria.',
};

const pgArray = (values: readonly string[]) => `{${values.join(',')}}`;

const CONTACT_COLUMNS = [
  'id',
  'agency_id',
  'owner_user_id',
  'types',
  'first_name',
  'last_name',
  'primary_email',
  'primary_phone',
  'language',
  'source',
  'consent_marketing',
  'consent_marketing_at',
  'consent_processing',
  'consent_processing_at',
  'created_at',
  'updated_at',
] as const;
const EMAIL_COLUMNS = ['id', 'agency_id', 'contact_id', 'email', 'position', 'created_at'] as const;
const PHONE_COLUMNS = ['id', 'agency_id', 'contact_id', 'phone', 'position', 'created_at'] as const;
/** Keyed by `contact_id` (a contact's facets are written together, so its first row tells whether they exist). */
const FACET_COLUMNS = ['contact_id', 'agency_id', 'facet'] as const;
const LEAD_COLUMNS = [
  'id',
  'agency_id',
  'contact_id',
  'source',
  'kind',
  'status',
  'stage_id',
  'stage_rank',
  'stage_entered_at',
  'target_kind',
  'target_id',
  'message',
  'locale',
  'visitor_name',
  'visitor_email',
  'visitor_marketing_consent',
  'assigned_user_id',
  'assigned_at',
  'first_responded_at',
  'first_human_response_at',
  'first_responder_user_id',
  'response_seconds',
  'created_by',
  'created_at',
  'updated_at',
] as const;
const ACTIVITY_COLUMNS = [
  'id',
  'agency_id',
  'occurred_at',
  'type',
  'contact_id',
  'lead_id',
  'actor_user_id',
  'body',
  'created_at',
] as const;
const TASK_COLUMNS = [
  'id',
  'agency_id',
  'title',
  'status',
  'due_at',
  'remind',
  'assigned_user_id',
  'created_by',
  'contact_id',
  'lead_id',
  'completed_at',
  'completed_by_user_id',
  'created_at',
  'updated_at',
] as const;
const EVENT_COLUMNS = [
  'id',
  'agency_id',
  'type',
  'title',
  'location',
  'starts_at',
  'ends_at',
  'status',
  'organizer_user_id',
  'created_by',
  'listing_id',
  'cancelled_at',
  'created_at',
  'updated_at',
] as const;
const ATTENDEE_COLUMNS = ['id', 'agency_id', 'event_id', 'user_id', 'contact_id', 'starts_at', 'created_at'] as const;

interface SeedContact {
  id: string;
  first: string;
  last: string;
  email: string | null;
  language: string;
  marketing: boolean;
}

interface AgencyRows {
  contacts: CopyValue[][];
  emails: CopyValue[][];
  phones: CopyValue[][];
  facets: CopyValue[][];
  leads: CopyValue[][];
  activities: CopyValue[][];
  tasks: CopyValue[][];
  events: CopyValue[][];
  attendees: CopyValue[][];
}

const emptyRows = (): AgencyRows => ({
  contacts: [],
  emails: [],
  phones: [],
  facets: [],
  leads: [],
  activities: [],
  tasks: [],
  events: [],
  attendees: [],
});

function drawTypes(rng: Rng): string[] {
  const r = rng.next();
  if (r < 0.6) return ['BUYER'];
  if (r < 0.75) return ['SELLER'];
  if (r < 0.85) return ['TENANT'];
  if (r < 0.92) return ['LANDLORD'];
  return ['BUYER', 'SELLER'];
}

function drawStage(rng: Rng): Stage {
  const r = rng.next();
  return r < 0.3 ? 'NEW' : r < 0.7 ? 'IN_PROGRESS' : r < 0.8 ? 'WON' : r < 0.95 ? 'LOST' : 'SPAM';
}

/** Agency `a`'s rows, into `out`. `stages`: the agency's active stage per status (`NEW` always present). */
function agencyRows(seed: number, a: number, anchor: Date, stages: ReadonlyMap<string, string>, out: AgencyRows): void {
  const rng = createRng(seed, `crm:${a}`);
  const agencyId = seededId(seed, 'agencies', a);
  const users = Array.from({ length: PER_AGENCY.users }, (_, u) => seededId(seed, `identity.users:${a}`, u));
  const user = (k: number) => users[k % users.length] as string;
  const listing = () => seededListingId(seed, a, rng.int(0, listingsOf(a) - 1));
  const anchorMs = anchor.getTime();
  const entryStage = stages.get('NEW') as string;

  // contacts, their identifiers and facets
  const people: SeedContact[] = [];
  for (let i = 0; i < PER_AGENCY.contacts; i++) {
    const id = seededContactId(seed, a, i);
    const first = rng.pick(FIRST);
    const last = rng.pick(LAST);
    const types = drawTypes(rng);
    const email = rng.next() < 0.9 ? contactEmail(seed, a, i) : null;
    const phone = rng.next() < 0.7 ? contactPhone(i) : null;
    const language = rng.pick(LANGUAGES);
    const marketing = rng.next() < 0.4;
    const processing = rng.next() < 0.9;
    const at = new Date(SEEDED_AT.getTime() - (PER_AGENCY.contacts - i) * 3 * HOUR);
    people.push({ id, first, last, email, language, marketing });
    out.contacts.push([
      id,
      agencyId,
      i % 10 === 9 ? null : user(i),
      pgArray(types),
      first,
      last,
      email,
      phone,
      language,
      rng.pick(CONTACT_SOURCES),
      marketing,
      marketing ? at : null,
      processing,
      processing ? at : null,
      at,
      at,
    ]);
    if (email) out.emails.push([seededId(seed, `crm.contact_emails:${a}`, i), agencyId, id, email, 0, at]);
    if (phone) out.phones.push([seededId(seed, `crm.contact_phones:${a}`, i), agencyId, id, phone, 0, at]);
    for (const t of types) out.facets.push([id, agencyId, `type:${t}`]);
  }

  // leads: contact j × LEAD_EVERY, over the 100 days before the anchor, newest last
  const leadIds: string[] = [];
  const leadCreated: number[] = [];
  for (let j = 0; j < PER_AGENCY.leads; j++) {
    const id = seededLeadId(seed, a, j);
    leadIds.push(id);
    const c = people[j * LEAD_EVERY] as SeedContact;
    // one lead in ten (`LEAD_UNASSIGNED`) waits in the inbox, new and unassigned; the others are their member's
    // (`user(j)`), so a member's leads — and the notifications that link them — are known without the draws
    const unassigned = j % 10 === LEAD_UNASSIGNED;
    const drawn = drawStage(rng);
    const status = unassigned ? 'NEW' : drawn;
    const stageId = stages.get(status) ?? entryStage;
    const stageStatus = stages.has(status) ? status : 'NEW';
    const created = new Date(anchorMs - (PER_AGENCY.leads - j) * 6 * HOUR);
    leadCreated.push(created.getTime());
    const assigned = unassigned ? null : user(j);
    const source = rng.pick(LEAD_SOURCES);
    const responded = stageStatus !== 'NEW' && assigned !== null;
    // answered before the seed day (a lead of the last hours answered in the minutes it had)
    const seconds = responded
      ? Math.min(rng.int(300, 86_400), Math.floor((anchorMs - created.getTime()) / 1000))
      : null;
    const answeredAt = seconds === null ? null : new Date(created.getTime() + seconds * 1000);
    const entered = answeredAt && stageStatus !== 'NEW' ? answeredAt : created;
    out.leads.push([
      id,
      agencyId,
      c.id,
      source,
      rng.next() < 0.8 ? 'ENQUIRY' : 'VIEWING_REQUEST',
      stageStatus,
      stageId,
      timeRank(entered, id),
      entered,
      'LISTING',
      listing(),
      'Hello, I would like more information about this property.',
      c.language,
      `${c.first} ${c.last}`,
      c.email,
      c.marketing,
      assigned,
      assigned ? created : null,
      answeredAt,
      answeredAt,
      responded ? assigned : null,
      seconds,
      source === 'MANUAL' ? (assigned ?? user(0)) : null,
      created,
      entered,
    ]);
  }

  // activities: one per contact in the ACTIVITY_DAYS before the anchor, two more per lead between the lead's arrival
  // and the anchor (at most 100 days back: inside the partitions pg_partman keeps)
  let k = 0;
  const activity = (contact: number, lead: string | null, sinceMs: number) => {
    const type = rng.pick(MANUAL_TYPES);
    const at = new Date(anchorMs - rng.int(1, Math.max(1, Math.floor((anchorMs - sinceMs) / MINUTE))) * MINUTE);
    out.activities.push([
      seededId(seed, `crm.activities:${a}`, k++),
      agencyId,
      at,
      type,
      (people[contact] as SeedContact).id,
      lead,
      user(contact + rng.int(0, 1)),
      ACTIVITY_BODY[type],
      at,
    ]);
  };
  for (let i = 0; i < PER_AGENCY.contacts; i++) activity(i, null, anchorMs - ACTIVITY_DAYS * DAY);
  for (let j = 0; j < PER_AGENCY.leads; j++) {
    activity(j * LEAD_EVERY, leadIds[j] as string, leadCreated[j] as number);
    activity(j * LEAD_EVERY, leadIds[j] as string, leadCreated[j] as number);
  }

  // tasks: 30 per member, 60 % open (some overdue, some undated), the rest done in the past
  for (let t = 0; t < PER_AGENCY.tasks; t++) {
    const ci = (t * 13) % PER_AGENCY.contacts;
    const c = people[ci] as SeedContact;
    const assignee = user(t);
    const open = rng.next() < 0.6;
    const due = open
      ? rng.next() < 0.1
        ? null
        : new Date(anchorMs + rng.int(-7 * 24, 30 * 24) * HOUR)
      : new Date(anchorMs - rng.int(1, 60 * 24) * HOUR);
    const created = new Date(Math.min(due?.getTime() ?? anchorMs, anchorMs) - rng.int(1, 14) * DAY);
    const title = rng.pick([
      `Call ${c.first} ${c.last} back`,
      `Send ${c.first} new listings`,
      `Book a viewing with ${c.first} ${c.last}`,
      `Follow up the offer of ${c.first} ${c.last}`,
    ]);
    out.tasks.push([
      seededId(seed, `crm.tasks:${a}`, t),
      agencyId,
      title,
      open ? 'OPEN' : 'DONE',
      due,
      false,
      assignee,
      assignee,
      c.id,
      ci % LEAD_EVERY === 0 ? (leadIds[ci / LEAD_EVERY] as string) : null,
      open ? null : due,
      open ? null : assignee,
      created,
      open ? created : due,
    ]);
  }

  // calendar: CALENDAR_WEEKS of events from CALENDAR_WEEKS_BEFORE weeks before the anchor, working hours (UTC)
  const from = anchorMs - CALENDAR_WEEKS_BEFORE * 7 * DAY;
  let n = 0;
  for (let e = 0; e < PER_AGENCY.calendarEvents; e++) {
    const id = seededId(seed, `crm.calendar_events:${a}`, e);
    const day = Math.floor((e * CALENDAR_WEEKS * 7) / PER_AGENCY.calendarEvents);
    const starts = new Date(from + day * DAY + rng.int(18, 35) * 30 * MINUTE);
    const ends = new Date(starts.getTime() + rng.pick([30, 60, 60, 90]) * MINUTE);
    const r = rng.next();
    const type = r < 0.5 ? 'VIEWING' : r < 0.8 ? 'MEETING' : 'CALL';
    const ci = (e * 17) % PER_AGENCY.contacts;
    const c = people[ci] as SeedContact;
    const organizer = user(e);
    const cancelled = rng.next() < 0.05;
    const created = new Date(Math.min(starts.getTime() - 7 * DAY, anchorMs));
    const title =
      type === 'VIEWING'
        ? `Viewing with ${c.first} ${c.last}`
        : type === 'MEETING'
          ? `Meeting ${c.first} ${c.last}`
          : `Call ${c.first} ${c.last}`;
    out.events.push([
      id,
      agencyId,
      type,
      title,
      type === 'CALL' ? null : type === 'VIEWING' ? 'At the property' : 'At the office',
      starts,
      ends,
      cancelled ? 'CANCELLED' : 'SCHEDULED',
      organizer,
      organizer,
      type === 'VIEWING' ? listing() : null,
      cancelled ? created : null,
      created,
      created,
    ]);
    const attendee = (userId: string | null, contactId: string | null) =>
      out.attendees.push([
        seededId(seed, `crm.calendar_event_attendees:${a}`, n++),
        agencyId,
        id,
        userId,
        contactId,
        starts,
        created,
      ]);
    attendee(organizer, null);
    if (rng.next() < 0.3) attendee(user(e + rng.int(1, PER_AGENCY.users - 1)), null);
    if (type !== 'CALL' || rng.next() < 0.5) attendee(null, c.id);
  }
}

/**
 * The default pipeline of each agency (the five `PIPELINE_STAGE_KEYS`, as `crm.seedStages` writes them), unless it has
 * stages; then every agency's active stage per status. One statement each.
 */
async function ensureStages(
  client: pg.PoolClient,
  seed: number,
  agencies: readonly number[],
): Promise<Map<string, Map<string, string>>> {
  const rows: { id: string; agency_id: string; k: string; pos: number }[] = [];
  const ids: string[] = [];
  for (const a of agencies) {
    const agencyId = seededId(seed, 'agencies', a);
    ids.push(agencyId);
    PIPELINE_STAGE_KEYS.forEach((k, pos) => {
      rows.push({ id: seededStageId(seed, a, pos), agency_id: agencyId, k, pos });
    });
  }
  // only for an agency with no stage at all (the service's own rule, `entryStageAndRule`)
  await client.query(
    `insert into pipeline_stages (id, agency_id, seed_key, status, position, created_at, updated_at)
     select x.id, x.agency_id, x.k, x.k, x.pos, $2, $2 from jsonb_to_recordset($1::jsonb)
         as x(id uuid, agency_id uuid, k text, pos int)
      where not exists (select 1 from pipeline_stages s where s.agency_id = x.agency_id and s.id <> x.id)
     on conflict do nothing`,
    [JSON.stringify(rows), SEEDED_AT],
  );
  const found = await client.query<{ agency_id: string; id: string; status: string }>(
    `select agency_id, id, status from pipeline_stages
      where agency_id = any($1::uuid[]) and archived_at is null order by agency_id, position desc, id desc`,
    [ids],
  );
  const out = new Map<string, Map<string, string>>();
  // position desc: the first active stage per status (lowest position) is set last and wins
  for (const r of found.rows) {
    const m = out.get(r.agency_id) ?? new Map<string, string>();
    m.set(r.status, r.id);
    out.set(r.agency_id, m);
  }
  return out;
}

export const crmSeeder: Seeder = {
  name: 'crm.contacts',

  async dev() {
    return { inserted: 0, total: 0 };
  },

  async scale({ agencies: count, seed, chunk, anchor: given, onProgress }) {
    const anchor = seedAnchor(given);
    const write = (start: number, end: number) =>
      withSystemClient('seed.crm.scale', async (client) => {
        // An agency's CRM is written in one transaction: its first contact there means all of it is (a re-run, or a
        // resumed one, skips it whole — no per-row existence check over ~11k rows per agency).
        // Any of its first and last contact or its last lead present: a hard-deleted contact never causes a re-seed
        // that conflicts with the rest.
        const range = Array.from({ length: end - start }, (_, k) => start + k);
        const found = await client.query<{ agency_id: string }>(
          `select agency_id from contacts where id = any($1::uuid[])
           union select agency_id from leads where id = any($2::uuid[])`,
          [
            range.flatMap((a) => [seededContactId(seed, a, 0), seededContactId(seed, a, PER_AGENCY.contacts - 1)]),
            range.map((a) => seededLeadId(seed, a, PER_AGENCY.leads - 1)),
          ],
        );
        const done = new Set(found.rows.map((r) => r.agency_id));
        const todo = range.filter((a) => !done.has(seededId(seed, 'agencies', a)));
        if (todo.length === 0) return 0;
        const stages = await ensureStages(client, seed, todo);
        const rows = emptyRows();
        for (const a of todo) {
          const agencyStages = stages.get(seededId(seed, 'agencies', a));
          if (!agencyStages?.has('NEW')) throw new Error(`agency ${a} has no entry stage`);
          agencyRows(seed, a, anchor, agencyStages, rows);
        }
        const inserted = await copyRows(client, 'contacts', CONTACT_COLUMNS, rows.contacts);
        await copyRows(client, 'contact_emails', EMAIL_COLUMNS, rows.emails);
        await copyRows(client, 'contact_phones', PHONE_COLUMNS, rows.phones);
        await copyRows(client, 'contact_facets', FACET_COLUMNS, rows.facets);
        await copyRows(client, 'leads', LEAD_COLUMNS, rows.leads);
        await copyRows(client, 'activities', ACTIVITY_COLUMNS, rows.activities);
        await copyRows(client, 'tasks', TASK_COLUMNS, rows.tasks);
        await copyRows(client, 'calendar_events', EVENT_COLUMNS, rows.events);
        await copyRows(client, 'calendar_event_attendees', ATTENDEE_COLUMNS, rows.attendees);
        return inserted;
      });
    const step = Math.max(1, Math.min(chunk, CRM_AGENCIES_PER_CHUNK));
    const inserted = await forEachChunk(count, step, write, onProgress);
    const agencyIds = Array.from({ length: count }, (_, a) => seededId(seed, 'agencies', a));
    const r = await withSystem('seed.crm.count', (tx) =>
      tx.execute<{ n: number }>(
        // seeded contacts predate SEEDED_AT; one a load test created through the service does not
        sql`select count(*)::int as n from contacts
             where agency_id = any(${pgArray(agencyIds)}::uuid[]) and created_at <= ${SEEDED_AT}`,
      ),
    );
    return { inserted, total: r.rows[0]?.n ?? 0 };
  },
};
