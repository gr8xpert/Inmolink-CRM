/**
 * The crm side of the data export (S10-08, PATTERNS §12 "Cross-module functions for workers"): raw `tx` — the
 * compliance worker reads as the agency (`withTenant`, RLS) — no authorization (compliance authorizes the export),
 * never called from request code. Keyset pages newest first on the stored `created_ms` and the id (`keyset.ts`): one
 * statement per page, the identifiers aggregated per row in the same statement (no N+1).
 */
import type { Tx } from '@inmolink/db';
import { contacts, leads } from '@inmolink/db/schema/crm';
import { and, eq, isNull, sql } from 'drizzle-orm';
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
