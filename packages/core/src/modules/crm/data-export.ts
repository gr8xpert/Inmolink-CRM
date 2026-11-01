/**
 * The crm side of the data export (S10-08, PATTERNS §12 "Cross-module functions for workers"): raw `tx` — the
 * compliance worker reads as the agency (`withTenant`, RLS) — no authorization (compliance authorizes the export),
 * never called from request code. Keyset pages newest first on the stored `created_ms` and the id (`keyset.ts`): one
 * statement per page, the identifiers aggregated per row in the same statement (no N+1).
 */
import type { Tx } from '@inmolink/db';
import {
  activities,
  calendarEventAttendees,
  calendarEvents,
  contactNotes,
  contacts,
  leads,
  sellerProspects,
  tasks,
} from '@inmolink/db/schema/crm';
import { type AnyColumn, and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { type KeysetCursor, rowAfter, rowOrder } from '../../pagination';

/** Most rows one page may ask for. */
export const EXPORT_PAGE_MAX = 2_000;

export interface ExportPageQuery {
  /** The last row of the previous page (`{ at: createdMs, id }`); null for the first page. */
  after: KeysetCursor | null;
  limit: number;
}

const limitOf = (q: ExportPageQuery) => Math.max(1, Math.min(q.limit, EXPORT_PAGE_MAX));

/** One open contact (merged ones are left out: their data lives in the survivor), with every e-mail and phone. */
export async function contactsForExport(tx: Tx, agencyId: string, q: ExportPageQuery) {
  return tx
    .select({
      id: contacts.id,
      createdMs: contacts.createdMs,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      // Correlated subqueries spelled out with table-qualified names: drizzle renders columns unqualified inside a
      // select's fields, where `id` / `agency_id` would resolve to the identifier table's own columns.
      emails: sql<string[]>`coalesce((select array_agg(e.email order by e.position) from contact_emails e
        where e.agency_id = "contacts"."agency_id" and e.contact_id = "contacts"."id"), '{}'::text[])`,
      phones: sql<string[]>`coalesce((select array_agg(p.phone order by p.position) from contact_phones p
        where p.agency_id = "contacts"."agency_id" and p.contact_id = "contacts"."id"), '{}'::text[])`,
      types: contacts.types,
      tags: contacts.tags,
      language: contacts.language,
      source: contacts.source,
      ownerUserId: contacts.ownerUserId,
      consentMarketing: contacts.consentMarketing,
      consentMarketingAt: contacts.consentMarketingAt,
      consentProcessing: contacts.consentProcessing,
      consentProcessingAt: contacts.consentProcessingAt,
      doNotContact: contacts.doNotContact,
      createdAt: contacts.createdAt,
      updatedAt: contacts.updatedAt,
    })
    .from(contacts)
    .where(
      and(
        eq(contacts.agencyId, agencyId),
        isNull(contacts.deletedAt),
        rowAfter(contacts.createdMs, contacts.id, q.after ?? undefined),
      ),
    )
    .orderBy(...rowOrder(contacts.createdMs, contacts.id))
    .limit(limitOf(q));
}

export type ExportContactRow = Awaited<ReturnType<typeof contactsForExport>>[number];

/** One lead of the agency's inbox, with the client's message and the details the client gave. */
export async function leadsForExport(tx: Tx, agencyId: string, q: ExportPageQuery) {
  return tx
    .select({
      id: leads.id,
      createdMs: leads.createdMs,
      contactId: leads.contactId,
      source: leads.source,
      kind: leads.kind,
      status: leads.status,
      targetKind: leads.targetKind,
      targetId: leads.targetId,
      shownRef: leads.shownRef,
      ownerAgencyId: leads.ownerAgencyId,
      presentingAgencyId: leads.presentingAgencyId,
      message: leads.message,
      locale: leads.locale,
      visitorName: leads.visitorName,
      visitorEmail: leads.visitorEmail,
      visitorPhone: leads.visitorPhone,
      visitorMarketingConsent: leads.visitorMarketingConsent,
      assignedUserId: leads.assignedUserId,
      assignedAt: leads.assignedAt,
      firstRespondedAt: leads.firstRespondedAt,
      createdAt: leads.createdAt,
      updatedAt: leads.updatedAt,
    })
    .from(leads)
    .where(and(eq(leads.agencyId, agencyId), rowAfter(leads.createdMs, leads.id, q.after ?? undefined)))
    .orderBy(...rowOrder(leads.createdMs, leads.id))
    .limit(limitOf(q));
}

export type ExportLeadRow = Awaited<ReturnType<typeof leadsForExport>>[number];

// ---- one data subject (S16-04, GDPR Art. 15 / 20: `SUBJECT` exports) ----

/** Rows per page of a subject table (S16-F5: every table is paged — a person past 1,000 rows gets them all). */
export const SUBJECT_PAGE_MAX = 1_000;

/**
 * A subject page's position: the last row's sort time **as Postgres wrote it** (`cursorAt`, text with microseconds —
 * a JS `Date` holds only milliseconds, so a cursor rebuilt from it would repeat the row) and its id; null for the
 * first page. S16-F5 review: the raw column stays the sort key, so every page is an index range scan in order.
 */
export interface SubjectPage {
  after: { at: string; id: string } | null;
  limit?: number;
}

const pageLimit = (q: SubjectPage) => Math.max(1, Math.min(q.limit ?? SUBJECT_PAGE_MAX, SUBJECT_PAGE_MAX));
const pageAfter = (at: AnyColumn, id: AnyColumn, q: SubjectPage) =>
  q.after ? sql`(${at}, ${id}) > (${q.after.at}::timestamptz, ${q.after.id}::uuid)` : undefined;
const pageOrder = (at: AnyColumn, id: AnyColumn) => [asc(at), asc(id)];
/** The exact sort time of a row, for the next page's cursor. */
const cursorAt = (at: AnyColumn) => sql<string>`${at}::text`;

/** The subject's contact row (open contacts only), with every e-mail and phone; null when there is none. */
export async function subjectContact(tx: Tx, agencyId: string, contactId: string) {
  const [row] = await contactsForExportWhere(tx, agencyId, eq(contacts.id, contactId));
  return row ?? null;
}

function contactsForExportWhere(tx: Tx, agencyId: string, where: ReturnType<typeof eq>) {
  return tx
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      emails: sql<string[]>`coalesce((select array_agg(e.email order by e.position) from contact_emails e
        where e.agency_id = "contacts"."agency_id" and e.contact_id = "contacts"."id"), '{}'::text[])`,
      phones: sql<string[]>`coalesce((select array_agg(p.phone order by p.position) from contact_phones p
        where p.agency_id = "contacts"."agency_id" and p.contact_id = "contacts"."id"), '{}'::text[])`,
      types: contacts.types,
      tags: contacts.tags,
      language: contacts.language,
      source: contacts.source,
      consentMarketing: contacts.consentMarketing,
      consentMarketingAt: contacts.consentMarketingAt,
      consentProcessing: contacts.consentProcessing,
      consentProcessingAt: contacts.consentProcessingAt,
      doNotContact: contacts.doNotContact,
      createdAt: contacts.createdAt,
      updatedAt: contacts.updatedAt,
    })
    .from(contacts)
    .where(and(eq(contacts.agencyId, agencyId), isNull(contacts.deletedAt), where))
    .limit(1);
}

export type SubjectContactRow = NonNullable<Awaited<ReturnType<typeof subjectContact>>>;

/** A page of the subject's notes, oldest first (`contact_notes_contact_created_raw_idx`). */
export function subjectNotes(tx: Tx, agencyId: string, contactId: string, q: SubjectPage = { after: null }) {
  return tx
    .select({
      id: contactNotes.id,
      body: contactNotes.body,
      createdAt: contactNotes.createdAt,
      cursorAt: cursorAt(contactNotes.createdAt),
    })
    .from(contactNotes)
    .where(
      and(
        eq(contactNotes.agencyId, agencyId),
        eq(contactNotes.contactId, contactId),
        pageAfter(contactNotes.createdAt, contactNotes.id, q),
      ),
    )
    .orderBy(...pageOrder(contactNotes.createdAt, contactNotes.id))
    .limit(pageLimit(q));
}

/** A page of the subject's leads with what they wrote and gave, oldest first (`leads_contact_idx`). */
export function subjectLeads(tx: Tx, agencyId: string, contactId: string, q: SubjectPage = { after: null }) {
  return tx
    .select({
      id: leads.id,
      source: leads.source,
      kind: leads.kind,
      status: leads.status,
      targetKind: leads.targetKind,
      shownRef: leads.shownRef,
      message: leads.message,
      locale: leads.locale,
      visitorName: leads.visitorName,
      visitorEmail: leads.visitorEmail,
      visitorPhone: leads.visitorPhone,
      visitorMarketingConsent: leads.visitorMarketingConsent,
      inboundLeadId: leads.inboundLeadId,
      createdAt: leads.createdAt,
      cursorAt: cursorAt(leads.createdAt),
    })
    .from(leads)
    .where(and(eq(leads.agencyId, agencyId), eq(leads.contactId, contactId), pageAfter(leads.createdAt, leads.id, q)))
    .orderBy(...pageOrder(leads.createdAt, leads.id))
    .limit(pageLimit(q));
}

/** A page of the subject's tasks, oldest first (`tasks_contact_idx`). */
export function subjectTasks(tx: Tx, agencyId: string, contactId: string, q: SubjectPage = { after: null }) {
  return tx
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      dueAt: tasks.dueAt,
      completedAt: tasks.completedAt,
      createdAt: tasks.createdAt,
      cursorAt: cursorAt(tasks.createdAt),
    })
    .from(tasks)
    .where(and(eq(tasks.agencyId, agencyId), eq(tasks.contactId, contactId), pageAfter(tasks.createdAt, tasks.id, q)))
    .orderBy(...pageOrder(tasks.createdAt, tasks.id))
    .limit(pageLimit(q));
}

/**
 * S16-F5: a page of the calendar events the subject attends (`calendar_event_attendees` by contact), oldest first —
 * the event's own text (title, description, location), type, times and status; not the members attending.
 */
export function subjectEvents(tx: Tx, agencyId: string, contactId: string, q: SubjectPage = { after: null }) {
  return tx
    .select({
      id: calendarEvents.id,
      type: calendarEvents.type,
      title: calendarEvents.title,
      description: calendarEvents.description,
      location: calendarEvents.location,
      startsAt: calendarEvents.startsAt,
      endsAt: calendarEvents.endsAt,
      status: calendarEvents.status,
      cursorAt: cursorAt(calendarEvents.startsAt),
    })
    .from(calendarEventAttendees)
    .innerJoin(
      calendarEvents,
      and(
        eq(calendarEvents.agencyId, calendarEventAttendees.agencyId),
        eq(calendarEvents.id, calendarEventAttendees.eventId),
      ),
    )
    .where(
      and(
        eq(calendarEventAttendees.agencyId, agencyId),
        eq(calendarEventAttendees.contactId, contactId),
        pageAfter(calendarEvents.startsAt, calendarEvents.id, q),
      ),
    )
    .orderBy(...pageOrder(calendarEvents.startsAt, calendarEvents.id))
    .limit(pageLimit(q));
}

/**
 * S16-F5: a page of the subject's seller prospects (the property they may sell): title, address, area, stage and the
 * agency's confidential notes about it (free text: flagged for review), oldest first. S16-F5 review: soft-deleted ones
 * too (still held: Art. 15), marked by `deletedAt`; not the agency's price estimate (its business). Ids of a converted
 * listing kept as ids.
 */
export function subjectProspects(tx: Tx, agencyId: string, contactId: string, q: SubjectPage = { after: null }) {
  return tx
    .select({
      id: sellerProspects.id,
      title: sellerProspects.title,
      address: sellerProspects.address,
      area: sellerProspects.area,
      stage: sellerProspects.stage,
      confidentialNotes: sellerProspects.confidentialNotes,
      listingId: sellerProspects.listingId,
      createdAt: sellerProspects.createdAt,
      deletedAt: sellerProspects.deletedAt,
      cursorAt: cursorAt(sellerProspects.createdAt),
    })
    .from(sellerProspects)
    .where(
      and(
        eq(sellerProspects.agencyId, agencyId),
        eq(sellerProspects.contactId, contactId),
        pageAfter(sellerProspects.createdAt, sellerProspects.id, q),
      ),
    )
    .orderBy(...pageOrder(sellerProspects.createdAt, sellerProspects.id))
    .limit(pageLimit(q));
}

/** S16-F5: a page of the website enquiries (`leads.inbound_lead_id`) the subject's leads came from, by id. */
export async function subjectInboundLeadIds(
  tx: Tx,
  agencyId: string,
  contactId: string,
  afterId: string | null,
  limit = SUBJECT_PAGE_MAX,
): Promise<string[]> {
  const rows = await tx
    .select({ id: leads.inboundLeadId })
    .from(leads)
    .where(
      and(
        eq(leads.agencyId, agencyId),
        eq(leads.contactId, contactId),
        isNotNull(leads.inboundLeadId),
        afterId ? sql`${leads.inboundLeadId} > ${afterId}::uuid` : undefined,
      ),
    )
    .orderBy(asc(leads.inboundLeadId))
    .limit(Math.min(limit, SUBJECT_PAGE_MAX));
  return rows.map((r) => r.id).filter((id): id is string => id !== null);
}

/**
 * Activity types about the person (S16-04 review): calls, e-mails, meetings, viewings, notes and their own pipeline
 * and selection events. Not `LISTING_STATUS_CHANGED` (a listing's event, which may name its owner side) — and never an
 * activity's `data` (ids of listings, agencies, terms) or listing id.
 */
export const SUBJECT_ACTIVITY_TYPES = [
  'CALL',
  'EMAIL',
  'MEETING',
  'VIEWING',
  'OTHER',
  'NOTE_ADDED',
  'CONTACT_MERGED',
  'LEAD_CREATED',
  'LEAD_UPDATED',
  'STAGE_CHANGED',
  'TASK_COMPLETED',
  'SELECTION_VIEWED',
  'SELECTION_LIKED',
  'SELECTION_ENQUIRED',
] as const;

/**
 * A page of the subject's activities — its own and its leads', of `SUBJECT_ACTIVITY_TYPES` only — oldest first after
 * `after`, at most `limit`. S16-F5 review: two branches, each an index range scan in `(occurred_at, id)` order and
 * cut at `limit` — its own (`activities_contact_idx`) and its leads' that do not name it too (`activities_lead_idx`,
 * the leads by subquery: a person past 1,000 leads keeps them all) — merged and cut again; on the raw `occurred_at`
 * (`cursorAt`, exact), so a page costs `limit` rows per branch whatever the subject's size.
 */
export async function subjectActivities(tx: Tx, agencyId: string, contactId: string, q: SubjectPage) {
  const limit = pageLimit(q);
  const after = q.after ? sql`and (a.occurred_at, a.id) > (${q.after.at}::timestamptz, ${q.after.id}::uuid)` : sql``;
  const types = sql`${sql.param([...SUBJECT_ACTIVITY_TYPES])}::text[]`;
  const res = await tx.execute(sql`
    select id, "occurredAt", type, "leadId", body, "cursorAt" from (
      (select a.id, a.occurred_at as "occurredAt", a.type, a.lead_id as "leadId", a.body,
              a.occurred_at::text as "cursorAt", a.occurred_at as k
         from ${activities} a
        where a.agency_id = ${agencyId} and a.contact_id = ${contactId} and a.type = any(${types}) ${after}
        order by a.occurred_at, a.id limit ${limit})
      union all
      (select a.id, a.occurred_at, a.type, a.lead_id, a.body, a.occurred_at::text, a.occurred_at
         from ${activities} a
        where a.agency_id = ${agencyId}
          and a.lead_id in (select l.id from ${leads} l where l.agency_id = ${agencyId} and l.contact_id = ${contactId})
          and a.contact_id is distinct from ${contactId}::uuid and a.type = any(${types}) ${after}
        order by a.occurred_at, a.id limit ${limit})
    ) page
    order by k, id
    limit ${limit}`);
  return (
    res.rows as {
      id: string;
      occurredAt: string | Date;
      type: string;
      leadId: string | null;
      body: string | null;
      cursorAt: string;
    }[]
  ).map((r) => ({ ...r, occurredAt: new Date(r.occurredAt) }));
}
