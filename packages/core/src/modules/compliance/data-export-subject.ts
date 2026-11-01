import { withTenant } from '@inmolink/db';
import type { ExportCell } from '@inmolink/platform/sheet';
import * as crm from '../crm';
import * as gdprRepo from './gdpr-repo';

/**
 * The `SUBJECT` data export (S16-04, GDPR Art. 15 access / Art. 20 portability): everything the agency holds about one
 * contact, as a ZIP of tables — `contact` (one row: names, e-mails, phones, types, tags, language, consents),
 * `notes`, `leads` (what the person wrote and gave), `tasks`, `activities` (its own and its leads', paged) and
 * `consents` (the consent history). Worker-only (`data-export-run.ts`): crm is read through its worker readers, as
 * the agency (`withTenant`, RLS), one short transaction per read. Ids of agents and listings are kept as ids — the
 * person's data, not the agency's internals; no commission, owner or internal listing field is part of it.
 */

export interface SubjectTable {
  name: 'contact' | 'notes' | 'leads' | 'tasks' | 'activities' | 'consents';
  header: readonly string[];
  rows: () => AsyncGenerator<ExportCell[]>;
}

/** The tables of free text the agency wrote, flagged in the manifest for review before the export is sent. */
export const SUBJECT_REVIEW_TABLES = ['notes', 'tasks', 'activities'] as const;

/** Consent records one subject export holds at most (a person changes a consent a handful of times). */
const CONSENT_ROWS = 10_000;
const ACTIVITY_PAGE = 1_000;

const list = (values: readonly string[] | null | undefined) => (values ?? []).join('; ');

export function subjectTables(agencyId: string, contactId: string): SubjectTable[] {
  const tenant = { agencyId };
  let leadIds: string[] = [];
  return [
    {
      name: 'contact',
      header: [
        'id',
        'first_name',
        'last_name',
        'emails',
        'phones',
        'types',
        'tags',
        'language',
        'source',
        'consent_marketing',
        'consent_marketing_at',
        'consent_processing',
        'consent_processing_at',
        'do_not_contact',
        'created_at',
        'updated_at',
      ],
      async *rows() {
        const c = await withTenant(tenant, (tx) => crm.subjectContact(tx, agencyId, contactId));
        if (!c) return;
        yield [
          c.id,
          c.firstName,
          c.lastName,
          list(c.emails),
          list(c.phones),
          list(c.types),
          list(c.tags),
          c.language,
          c.source,
          c.consentMarketing,
          c.consentMarketingAt,
          c.consentProcessing,
          c.consentProcessingAt,
          c.doNotContact,
          c.createdAt,
          c.updatedAt,
        ];
      },
    },
    {
      name: 'notes',
      header: ['id', 'body', 'created_at'],
      async *rows() {
        for (const n of await withTenant(tenant, (tx) => crm.subjectNotes(tx, agencyId, contactId))) {
          yield [n.id, n.body, n.createdAt];
        }
      },
    },
    {
      name: 'leads',
      header: [
        'id',
        'source',
        'kind',
        'status',
        'target_kind',
        'shown_ref',
        'message',
        'locale',
        'visitor_name',
        'visitor_email',
        'visitor_phone',
        'visitor_marketing_consent',
        'created_at',
      ],
      async *rows() {
        const rows = await withTenant(tenant, (tx) => crm.subjectLeads(tx, agencyId, contactId));
        leadIds = rows.map((l) => l.id);
        for (const l of rows) {
          yield [
            l.id,
            l.source,
            l.kind,
            l.status,
            l.targetKind,
            l.shownRef,
            l.message,
            l.locale,
            l.visitorName,
            l.visitorEmail,
            l.visitorPhone,
            l.visitorMarketingConsent,
            l.createdAt,
          ];
        }
      },
    },
    {
      name: 'tasks',
      header: ['id', 'title', 'description', 'status', 'due_at', 'completed_at'],
      async *rows() {
        for (const t of await withTenant(tenant, (tx) => crm.subjectTasks(tx, agencyId, contactId))) {
          yield [t.id, t.title, t.description, t.status, t.dueAt, t.completedAt];
        }
      },
    },
    {
      // after `leads` (the ZIP writes the tables in this order): its leads' activities are the person's too
      name: 'activities',
      header: ['id', 'occurred_at', 'type', 'lead_id', 'body'],
      async *rows() {
        let after: { at: Date; id: string } | null = null;
        for (;;) {
          const cursor: { at: Date; id: string } | null = after;
          const page: Awaited<ReturnType<typeof crm.subjectActivities>> = await withTenant(tenant, (tx) =>
            crm.subjectActivities(tx, agencyId, contactId, leadIds, { after: cursor, limit: ACTIVITY_PAGE }),
          );
          for (const a of page) yield [a.id, a.occurredAt, a.type, a.leadId, a.body];
          if (page.length < ACTIVITY_PAGE) return;
          const last = page[page.length - 1] as Awaited<ReturnType<typeof crm.subjectActivities>>[number];
          after = { at: last.occurredAt, id: last.id };
        }
      },
    },
    {
      name: 'consents',
      header: ['id', 'purpose', 'granted', 'source', 'policy_version', 'recorded_at'],
      async *rows() {
        const rows = await withTenant(tenant, (tx) => gdprRepo.consentsOf(tx, agencyId, contactId, CONSENT_ROWS));
        for (const r of rows) yield [r.id, r.purpose, r.granted, r.source, r.policyVersion, r.recordedAt];
      },
    },
  ];
}
