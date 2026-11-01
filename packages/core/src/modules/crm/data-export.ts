/**
 * The crm side of the data export (S10-08, PATTERNS §12 "Cross-module functions for workers"): raw `tx` — the
 * compliance worker reads as the agency (`withTenant`, RLS) — no authorization (compliance authorizes the export),
 * never called from request code. Keyset pages newest first on the stored `created_ms` and the id (`keyset.ts`): one
 * statement per page, the identifiers aggregated per row in the same statement (no N+1).
 */
import type { Tx } from '@inmolink/db';
import { activities, contactNotes, contacts, leads, tasks } from '@inmolink/db/schema/crm';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
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

/** Most rows one subject table may hold in an export page (activities are paged; the others are bounded per person). */
export const SUBJECT_PAGE_MAX = 1_000;

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

/** The subject's notes, oldest first (`contact_notes_contact_created_raw_idx`), at most `SUBJECT_PAGE_MAX`. */
export function subjectNotes(tx: Tx, agencyId: string, contactId: string) {
  return tx
    .select({ id: contactNotes.id, body: contactNotes.body, createdAt: contactNotes.createdAt })
    .from(contactNotes)
    .where(and(eq(contactNotes.agencyId, agencyId), eq(contactNotes.contactId, contactId)))
    .orderBy(asc(contactNotes.createdAt), asc(contactNotes.id))
    .limit(SUBJECT_PAGE_MAX);
}

/** The subject's leads with what they wrote and gave (at most `SUBJECT_PAGE_MAX`, oldest first). */
export function subjectLeads(tx: Tx, agencyId: string, contactId: string) {
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
      createdAt: leads.createdAt,
    })
    .from(leads)
    .where(and(eq(leads.agencyId, agencyId), eq(leads.contactId, contactId)))
    .orderBy(asc(leads.createdAt), asc(leads.id))
    .limit(SUBJECT_PAGE_MAX);
}

/** The subject's tasks (at most `SUBJECT_PAGE_MAX`). */
export function subjectTasks(tx: Tx, agencyId: string, contactId: string) {
  return tx
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      dueAt: tasks.dueAt,
      completedAt: tasks.completedAt,
    })
    .from(tasks)
    .where(and(eq(tasks.agencyId, agencyId), eq(tasks.contactId, contactId)))
    .orderBy(asc(tasks.id))
    .limit(SUBJECT_PAGE_MAX);
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
 * A page of the subject's activities — its own and its leads' (`activities_contact_idx`, `activities_lead_idx`), of
 * `SUBJECT_ACTIVITY_TYPES` only — oldest first after `after` (`{ at: occurredAt, id }`), at most `limit`.
 */
export function subjectActivities(
  tx: Tx,
  agencyId: string,
  contactId: string,
  leadIds: readonly string[],
  q: ExportPageQuery,
) {
  const of =
    leadIds.length > 0
      ? or(eq(activities.contactId, contactId), inArray(activities.leadId, [...leadIds]))
      : eq(activities.contactId, contactId);
  return tx
    .select({
      id: activities.id,
      occurredAt: activities.occurredAt,
      type: activities.type,
      leadId: activities.leadId,
      body: activities.body,
    })
    .from(activities)
    .where(
      and(
        eq(activities.agencyId, agencyId),
        of,
        inArray(activities.type, [...SUBJECT_ACTIVITY_TYPES]),
        q.after
          ? sql`(${activities.occurredAt}, ${activities.id}) > (${q.after.at.toISOString()}::timestamptz, ${q.after.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(asc(activities.occurredAt), asc(activities.id))
    .limit(limitOf(q));
}
