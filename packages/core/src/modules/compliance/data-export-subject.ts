import { withTenant } from '@inmolink/db';
import type { ExportCell } from '@inmolink/platform/sheet';
import * as crm from '../crm';
import * as documents from '../documents';
import * as matching from '../matching';
import * as mls from '../mls';
import * as presentations from '../presentations';
import * as websites from '../websites';
import * as gdprRepo from './gdpr-repo';

/**
 * The `SUBJECT` data export (S16-04, GDPR Art. 15 access / Art. 20 portability): everything the agency holds about one
 * contact, as a ZIP of tables. Worker-only (`data-export-run.ts`): every module is read through its own readers, as
 * the agency (`withTenant`, RLS), one short transaction per page. Ids of agents and listings are kept as ids — the
 * person's data, not the agency's internals; no commission, owner or internal listing field is part of it.
 *
 * S16-F5: every category the privacy notice lists (`SUBJECT_EXPORT_CATEGORIES`) — besides the contact, notes, leads,
 * tasks, activities and consents, the website enquiries their leads came from, the calendar events they attend, their
 * seller prospects, the selections made for them (and what they did on them), their client registrations and viewing
 * requests (R2-02a: and their search profiles; R2-05a: the forms made for them) — and every table is paged (`crm.SUBJECT_PAGE_MAX` rows per read), so nothing stops at 1,000 rows.
 */

export type SubjectTableName =
  | 'contact'
  | 'notes'
  | 'leads'
  | 'enquiries'
  | 'tasks'
  | 'events'
  | 'prospects'
  | 'selections'
  | 'selection_responses'
  | 'client_profiles'
  | 'registrations'
  | 'viewings'
  | 'forms'
  | 'activities'
  | 'consents';

export interface SubjectTable {
  name: SubjectTableName;
  header: readonly string[];
  rows: () => AsyncGenerator<ExportCell[]>;
}

/**
 * S16-F5: the categories of client data the privacy notice lists (`legal.privacy.sections.data`: "contacts,
 * enquiries, viewings, notes", and the CRM's follow-ups) and the export tables that hold each — the test proves a
 * seeded person's ZIP has every one.
 */
export const SUBJECT_EXPORT_CATEGORIES: Readonly<Record<string, readonly SubjectTableName[]>> = {
  contacts: ['contact', 'consents'],
  enquiries: ['leads', 'enquiries', 'selections', 'selection_responses', 'client_profiles'],
  viewings: ['registrations', 'viewings', 'events'],
  notes: ['notes', 'tasks', 'activities', 'prospects'],
};

/** The tables of free text the agency wrote, flagged in the manifest for review before the export is sent. */
export const SUBJECT_REVIEW_TABLES = ['notes', 'tasks', 'activities', 'events', 'prospects'] as const;

/** Consent records one subject export holds at most (a person changes a consent a handful of times). */
const CONSENT_ROWS = 10_000;
const ACTIVITY_PAGE = 1_000;

const list = (values: readonly string[] | null | undefined) => (values ?? []).join('; ');

/** crm's page cursor: the exact sort time as text (`cursorAt`) and the id. */
type Pos = { at: string; id: string };
/** mls's: its stored millisecond columns. */
type At = { at: Date; id: string };

/** Pages of `read` until one is short; `next` is the cursor after a page's last row. */
async function* paged<R, C>(read: (after: C | null) => Promise<R[]>, next: (last: R) => C, size: number) {
  let after: C | null = null;
  for (;;) {
    const cursor: C | null = after;
    const page: R[] = await read(cursor);
    for (const r of page) yield r;
    const last = page[page.length - 1];
    if (page.length < size || last === undefined) return;
    after = next(last);
  }
}

export function subjectTables(agencyId: string, contactId: string): SubjectTable[] {
  const tenant = { agencyId };
  const as = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant<T>(tenant, fn);
  const PAGE = crm.SUBJECT_PAGE_MAX;
  /** S16-F5: the selections read for `selections`, their responses after them. */
  const selectionIds: string[] = [];
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
        const c = await as((tx) => crm.subjectContact(tx, agencyId, contactId));
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
        const all = paged(
          (after: Pos | null) => as((tx) => crm.subjectNotes(tx, agencyId, contactId, { after })),
          (n) => ({ at: n.cursorAt, id: n.id }),
          PAGE,
        );
        for await (const n of all) yield [n.id, n.body, n.createdAt];
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
        'enquiry_id',
        'created_at',
      ],
      async *rows() {
        const all = paged(
          (after: Pos | null) => as((tx) => crm.subjectLeads(tx, agencyId, contactId, { after })),
          (l) => ({ at: l.cursorAt, id: l.id }),
          PAGE,
        );
        for await (const l of all) {
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
            l.inboundLeadId,
            l.createdAt,
          ];
        }
      },
    },
    {
      // S16-F5: what the person sent through a website form (the enquiries their leads were promoted from)
      name: 'enquiries',
      header: [
        'id',
        'kind',
        'locale',
        'name',
        'email',
        'phone',
        'message',
        'viewing_slots',
        'marketing_consent',
        'created_at',
      ],
      async *rows() {
        const ids = paged(
          (after: string | null) => as((tx) => crm.subjectInboundLeadIds(tx, agencyId, contactId, after, PAGE)),
          (id) => id,
          PAGE,
        );
        let batch: string[] = [];
        const flush = async () => {
          const rows = await as((tx) => websites.subjectInboundLeads(tx, agencyId, batch));
          batch = [];
          return rows;
        };
        const out = async function* () {
          for (const w of await flush()) {
            yield [
              w.id,
              w.kind,
              w.locale,
              w.name,
              w.email,
              w.phone,
              w.message,
              w.viewingSlots === null ? null : JSON.stringify(w.viewingSlots),
              w.marketingConsent,
              w.createdAt,
            ] as ExportCell[];
          }
        };
        for await (const id of ids) {
          batch.push(id);
          if (batch.length === PAGE) yield* out();
        }
        if (batch.length > 0) yield* out();
      },
    },
    {
      name: 'tasks',
      header: ['id', 'title', 'description', 'status', 'due_at', 'completed_at', 'created_at'],
      async *rows() {
        const all = paged(
          (after: Pos | null) => as((tx) => crm.subjectTasks(tx, agencyId, contactId, { after })),
          (t) => ({ at: t.cursorAt, id: t.id }),
          PAGE,
        );
        for await (const t of all) yield [t.id, t.title, t.description, t.status, t.dueAt, t.completedAt, t.createdAt];
      },
    },
    {
      name: 'events',
      header: ['id', 'type', 'title', 'description', 'location', 'starts_at', 'ends_at', 'status'],
      async *rows() {
        const all = paged(
          (after: Pos | null) => as((tx) => crm.subjectEvents(tx, agencyId, contactId, { after })),
          (e) => ({ at: e.cursorAt, id: e.id }),
          PAGE,
        );
        for await (const e of all) {
          yield [e.id, e.type, e.title, e.description, e.location, e.startsAt, e.endsAt, e.status];
        }
      },
    },
    {
      name: 'prospects',
      header: [
        'id',
        'title',
        'address',
        'area',
        'stage',
        'confidential_notes',
        'listing_id',
        'created_at',
        'deleted_at',
      ],
      async *rows() {
        const all = paged(
          (after: Pos | null) => as((tx) => crm.subjectProspects(tx, agencyId, contactId, { after })),
          (p) => ({ at: p.cursorAt, id: p.id }),
          PAGE,
        );
        for await (const p of all) {
          yield [p.id, p.title, p.address, p.area, p.stage, p.confidentialNotes, p.listingId, p.createdAt, p.deletedAt];
        }
      },
    },
    {
      // R2-05a: the forms made for them (listing agreements, reservations, viewing sheets, offers) — what and when
      name: 'forms',
      header: ['id', 'template', 'locale', 'status', 'label', 'listing_id', 'sha256', 'created_at', 'rendered_at'],
      async *rows() {
        const all = paged(
          (after: string | null) => as((tx) => documents.subjectForms(tx, agencyId, contactId, after, PAGE)),
          (f) => f.id,
          PAGE,
        );
        for await (const f of all) {
          yield [f.id, f.template, f.locale, f.status, f.label, f.listingId, f.sha256, f.createdAt, f.renderedAt];
        }
      },
    },
    {
      name: 'selections',
      header: ['id', 'title', 'message', 'locale', 'created_at', 'expires_at', 'revoked_at'],
      async *rows() {
        const all = paged(
          (after: string | null) => as((tx) => presentations.subjectSelections(tx, agencyId, contactId, after)),
          (s) => s.id,
          PAGE,
        );
        for await (const s of all) {
          selectionIds.push(s.id);
          yield [s.id, s.title, s.message, s.locale, s.createdAt, s.expiresAt, s.revokedAt];
        }
      },
    },
    {
      // after `selections` (the ZIP writes the tables in this order): the client's views, likes and enquiries
      name: 'selection_responses',
      header: ['id', 'selection_id', 'kind', 'listing_id', 'message', 'created_at'],
      async *rows() {
        for (let i = 0; i < selectionIds.length; i += PAGE) {
          const ids = selectionIds.slice(i, i + PAGE);
          const all = paged(
            (after: string | null) => as((tx) => presentations.subjectSelectionResponses(tx, agencyId, ids, after)),
            (r) => r.id,
            PAGE,
          );
          for await (const r of all) yield [r.id, r.selectionId, r.kind, r.listingId, r.message, r.createdAt];
        }
      },
    },
    {
      // R2-02a: what the client is looking for — criteria, their wishes, how the agency matches it
      name: 'client_profiles',
      header: [
        'id',
        'mode',
        'frequency',
        'transaction_type',
        'property_type_ids',
        'location_ids',
        'feature_ids',
        'price_min_cents',
        'price_max_cents',
        'beds_min',
        'baths_min',
        'area_min_m2',
        'area_max_m2',
        'wishes',
        'created_at',
        'updated_at',
      ],
      async *rows() {
        const all = paged(
          (after: string | null) => as((tx) => matching.subjectClientProfiles(tx, agencyId, contactId, after)),
          (p) => p.id,
          matching.SUBJECT_PROFILE_PAGE,
        );
        for await (const p of all) {
          yield [
            p.id,
            p.mode,
            p.frequency,
            p.transactionType,
            p.propertyTypeIds.join(' '),
            p.locationIds.join(' '),
            p.featureIds.join(' '),
            p.priceMinCents,
            p.priceMaxCents,
            p.bedsMin,
            p.bathsMin,
            p.areaMinM2,
            p.areaMaxM2,
            p.wishes,
            p.createdAt,
            p.updatedAt,
          ];
        }
      },
    },
    {
      name: 'registrations',
      header: ['id', 'target_kind', 'target_id', 'registered_at', 'expires_at'],
      async *rows() {
        const all = paged(
          (after: At | null) => as((tx) => mls.subjectRegistrations(tx, agencyId, contactId, { after })),
          (r) => ({ at: r.registeredMs, id: r.id }),
          PAGE,
        );
        for await (const r of all) yield [r.id, r.targetKind, r.targetId, r.registeredAt, r.expiresAt];
      },
    },
    {
      name: 'viewings',
      header: [
        'id',
        'target_kind',
        'target_id',
        'status',
        'proposed_start_at',
        'scheduled_at',
        'outcome',
        'created_at',
      ],
      async *rows() {
        const all = paged(
          (after: At | null) => as((tx) => mls.subjectViewings(tx, agencyId, contactId, { after })),
          (v) => ({ at: v.createdMs, id: v.id }),
          PAGE,
        );
        for await (const v of all) {
          yield [v.id, v.targetKind, v.targetId, v.status, v.proposedStartAt, v.scheduledAt, v.outcome, v.createdAt];
        }
      },
    },
    {
      // its leads' activities are the person's too (crm reads them by subquery)
      name: 'activities',
      header: ['id', 'occurred_at', 'type', 'lead_id', 'body'],
      async *rows() {
        const all = paged(
          (after: Pos | null) =>
            as((tx) => crm.subjectActivities(tx, agencyId, contactId, { after, limit: ACTIVITY_PAGE })),
          (a) => ({ at: a.cursorAt, id: a.id }),
          ACTIVITY_PAGE,
        );
        for await (const a of all) yield [a.id, a.occurredAt, a.type, a.leadId, a.body];
      },
    },
    {
      name: 'consents',
      header: ['id', 'purpose', 'granted', 'source', 'policy_version', 'recorded_at'],
      async *rows() {
        const rows = await as((tx) => gdprRepo.consentsOf(tx, agencyId, contactId, CONSENT_ROWS));
        for (const r of rows) yield [r.id, r.purpose, r.granted, r.source, r.policyVersion, r.recordedAt];
      },
    },
  ];
}
