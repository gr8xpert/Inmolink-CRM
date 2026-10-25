import { type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Tables owned by the mls module (PATTERNS §2). Only `packages/core/src/modules/mls` imports
 * this file (`pnpm check:boundaries`).
 *
 * S11-01, client registration (PLAN §3 #8). Each reader has its own table under one RLS policy (S11-01 perf review: two
 * policies on one table are ORed by the planner, so no list was index-ordered):
 * - `client_registrations` — the introducer's: the client's details, encrypted (`details_enc`, AES-256-GCM bound to
 *   agency, table, column and row), its crm contact, the target and the validity. STRICT. The before-insert trigger
 *   `client_registrations_receipt` (SECURITY DEFINER, migration 0130) caps the validity at the owner's
 *   `registrationValidityDays` and appends the owner's receipt; `client_registrations_guard` keeps app_user from deleting
 *   a registration (evidence for both sides).
 * - `client_registration_receipts` — the target owner's: "registered by Agency X" and until when, nothing of the client.
 *   STRICT on the owner's `agency_id`; only the trigger appends (registry `definerAppend`).
 * - `client_registration_fingerprints` — the introducer's keyed fingerprints (HMAC-SHA256, `HMAC_KEY`; one row per
 *   identifier and key candidate during an HMAC rotation window) with the registration's validity. The exclusion
 *   constraint `client_registration_fingerprints_valid_ex` (migration, btree_gist) refuses a second registration of the
 *   same fingerprint for the same target whose validity overlaps — across agencies, whatever RLS lets the inserting
 *   agency see. That is "first valid wins": an expired registration's range ended before a new one starts.
 */

/** The longest validity any agency may set (`agency_settings_registration_days_ck`: 1–1095 days). */
const MAX_VALIDITY = sql.raw(`interval '1095 days'`);

export const clientRegistrations = pgTable(
  'client_registrations',
  {
    id: uuid('id').primaryKey(),
    /** The introducer. */
    agencyId: uuid('agency_id').notNull(),
    /** The target's owner (its receipt is `client_registration_receipts`). */
    targetAgencyId: uuid('target_agency_id').notNull(),
    targetKind: text('target_kind').notNull(),
    targetId: uuid('target_id').notNull(),
    /** The introducer's crm contact (no FK across modules; a contact merge re-points it, `crm.contact.merged`). */
    contactId: uuid('contact_id').notNull(),
    registeredByUserId: uuid('registered_by_user_id'),
    /** `{ firstName, lastName, emails, phones }` as registered, encrypted (`rowCipher`). */
    detailsEnc: text('details_enc').notNull(),
    /** The database's time (`now()`): priority is the start, never the application's clock. */
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** `registered_at` to the millisecond (stored): the keyset sort key, leakproof under RLS. */
    registeredMs: timestamp('registered_ms', { withTimezone: true })
      .notNull()
      .generatedAlwaysAs((): SQL => sql`date_trunc('milliseconds', registered_at, 'UTC')`),
  },
  (t) => [
    // the introducer's list: where agency_id = ? and (registered_ms, id) < (?, ?) order by registered_ms desc, id desc
    index('client_registrations_agency_registered_idx').on(t.agencyId, t.registeredMs, t.id),
    // the merge re-point: where agency_id = ? and contact_id = ?
    index('client_registrations_contact_idx').on(t.agencyId, t.contactId),
    // the rehash job (S11-01, HMAC rotation): the agency's registrations still valid, by id
    index('client_registrations_agency_expires_idx').on(t.agencyId, t.expiresAt, t.id),
    // the fingerprints' FK: a fingerprint carries exactly its registration's target and (capped) validity
    unique('client_registrations_fingerprint_key_uq').on(t.agencyId, t.id, t.targetId, t.registeredAt, t.expiresAt),
    // S11-02, the viewing requests' FK: a request carries exactly its registration's parties and target
    unique('client_registrations_viewing_key_uq').on(t.id, t.agencyId, t.targetAgencyId, t.targetKind, t.targetId),
    check('client_registrations_owner_ck', sql`${t.targetAgencyId} <> ${t.agencyId}`),
    check('client_registrations_target_ck', sql`${t.targetKind} in ('LISTING', 'DEVELOPMENT')`),
    check(
      'client_registrations_validity_ck',
      sql`${t.expiresAt} > ${t.registeredAt} and ${t.expiresAt} <= ${t.registeredAt} + ${MAX_VALIDITY}`,
    ),
  ],
);

export const clientRegistrationReceipts = pgTable(
  'client_registration_receipts',
  {
    registrationId: uuid('registration_id').primaryKey(),
    /** The target's owner, who reads the receipt. */
    agencyId: uuid('agency_id').notNull(),
    /** The introducer ("registered by Agency X"). */
    introducerAgencyId: uuid('introducer_agency_id').notNull(),
    targetKind: text('target_kind').notNull(),
    targetId: uuid('target_id').notNull(),
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    registeredMs: timestamp('registered_ms', { withTimezone: true })
      .notNull()
      .generatedAlwaysAs((): SQL => sql`date_trunc('milliseconds', registered_at, 'UTC')`),
  },
  (t) => [
    // the owner's list: where agency_id = ? and (registered_ms, registration_id) < (?, ?) order by both desc
    index('client_registration_receipts_agency_registered_idx').on(t.agencyId, t.registeredMs, t.registrationId),
    check('client_registration_receipts_target_ck', sql`${t.targetKind} in ('LISTING', 'DEVELOPMENT')`),
  ],
);

export const clientRegistrationFingerprints = pgTable(
  'client_registration_fingerprints',
  {
    registrationId: uuid('registration_id').notNull(),
    agencyId: uuid('agency_id').notNull(),
    targetId: uuid('target_id').notNull(),
    /** HMAC-SHA256 (base64url) of `email:<normalized>` or `phone:<E.164>`; not reversible without `HMAC_KEY`. */
    fingerprint: text('fingerprint').notNull(),
    /**
     * S12-F8: `hmacKeyLabel` of the HMAC key that made `fingerprint` (16 base64url characters, not secret). Null for
     * fingerprints stored before S12-F8 (the rehash labels them when it recomputes the same value). Tells the rehash —
     * and `mls.fingerprintsPending` — which valid registrations still lack a current-key fingerprint.
     */
    keyId: text('key_id'),
    /** The registration's validity, copied: the exclusion constraint compares `[registered_at, expires_at)`. */
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // also serves the FK (agency_id, registration_id) → client_registrations: its leading columns
    primaryKey({ name: 'client_registration_fingerprints_pk', columns: [t.agencyId, t.registrationId, t.fingerprint] }),
    // the retention sweep: fingerprints long past expiry
    index('client_registration_fingerprints_expires_idx').on(t.expiresAt),
    foreignKey({
      name: 'client_registration_fingerprints_registration_fk',
      columns: [t.agencyId, t.registrationId, t.targetId, t.registeredAt, t.expiresAt],
      foreignColumns: [
        clientRegistrations.agencyId,
        clientRegistrations.id,
        clientRegistrations.targetId,
        clientRegistrations.registeredAt,
        clientRegistrations.expiresAt,
      ],
    })
      .onDelete('cascade')
      .onUpdate('cascade'),
    check(
      'client_registration_fingerprints_validity_ck',
      sql`${t.expiresAt} > ${t.registeredAt} and ${t.expiresAt} <= ${t.registeredAt} + ${MAX_VALIDITY}`,
    ),
    check('client_registration_fingerprints_key_id_ck', sql`${t.keyId} is null or ${t.keyId} ~ '^[A-Za-z0-9_-]{16}$'`),
  ],
);

/*
 * S11-02, viewing requests (PLAN §3 #9, §7 M10): the introducer asks the target's owner for a viewing of its registered
 * client, with the target's commission terms as a snapshot; the owner accepts (and so accepts the terms), declines or
 * proposes another time; the side awaited answers a reschedule; either side records the outcome. Two readers, two
 * tables, one RLS policy each (S11-01 perf review):
 * - `viewing_requests` — the introducer's: its registration and contact (the client stays on its side), the state and
 *   the terms snapshot. STRICT.
 * - `viewing_request_receipts` — the owner's copy: the same state and terms, the introducer agency, nothing of the
 *   client. STRICT; appended only by the trigger `viewing_requests_receipt` (registry `guardedInsert`).
 * Each side changes only its own row; `viewing_requests_sync` / `viewing_request_receipts_sync` (SECURITY DEFINER,
 * registry `definerSync`) copy the shared state to the other side's row in the same statement. The terms columns are
 * never writable by app_user, the owner's acceptance only from the owner's row, and `viewing_terms_guard` (both tables,
 * every role) refuses any change of the terms or of an acceptance once the owner has accepted (the introducer accepts
 * by requesting): immutable after both acceptances.
 */

/** Columns both tables carry: the request's state and the terms snapshot (the triggers copy them). */
const viewingState = () => ({
  targetKind: text('target_kind').notNull(),
  targetId: uuid('target_id').notNull(),
  /** `REQUESTED` → `SCHEDULED` → `COMPLETED`; or `DECLINED`, `CANCELLED`, `EXPIRED`. */
  status: text('status').notNull(),
  /** `REQUESTED` only: the side that must answer the time on the table (`OWNER` or `INTRODUCER`). */
  awaiting: text('awaiting'),
  /** The time on the table (the last proposal). */
  proposedStartAt: timestamp('proposed_start_at', { withTimezone: true }).notNull(),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  /** An unanswered proposal lapses here (the configured days, or the proposed time if sooner): the expiry job. */
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  /** `COMPLETED` only: `ATTENDED` or `NO_SHOW`. */
  outcome: text('outcome'),
  outcomeAt: timestamp('outcome_at', { withTimezone: true }),
  /**
   * Who closed it: `OWNER` or `INTRODUCER` (`DECLINED`, `CANCELLED`), `SYSTEM` (`EXPIRED`: an unanswered proposal, or a
   * scheduled viewing whose outcome nobody recorded before the terms lapsed).
   */
  closedBy: text('closed_by'),
  // ---- the terms snapshot (PLAN §3 #9): the target's own terms when requested, accepted as they are ----
  /** A percentage of the sale price (basis points) — or `commission_fixed_cents`, never both. */
  commissionBp: integer('commission_bp'),
  commissionFixedCents: bigint('commission_fixed_cents', { mode: 'number' }),
  commissionCurrency: char('commission_currency', { length: 3 }),
  /** The introducer's share of the commission (basis points; a developer pays a development's commission whole). */
  splitBp: integer('split_bp').notNull(),
  commissionIncludesVat: boolean('commission_includes_vat').notNull(),
  /** The terms bind a viewing until the client's registration ends. */
  termsValidUntil: timestamp('terms_valid_until', { withTimezone: true }).notNull(),
  termsAt: timestamp('terms_at', { withTimezone: true }).notNull().defaultNow(),
  /** The introducer accepts the terms by requesting. */
  introducerAcceptedAt: timestamp('introducer_accepted_at', { withTimezone: true }).notNull().defaultNow(),
  introducerAcceptedBy: uuid('introducer_accepted_by'),
  /** The owner accepts them by accepting the request (or proposing another time): from then on nothing of them changes. */
  ownerAcceptedAt: timestamp('owner_accepted_at', { withTimezone: true }),
  ownerAcceptedBy: uuid('owner_accepted_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** `created_at` to the millisecond (stored): the keyset sort key. */
  createdMs: timestamp('created_ms', { withTimezone: true })
    .notNull()
    .generatedAlwaysAs((): SQL => sql`date_trunc('milliseconds', created_at, 'UTC')`),
});

type ViewingChecked =
  | 'targetKind'
  | 'status'
  | 'awaiting'
  | 'expiresAt'
  | 'scheduledAt'
  | 'outcome'
  | 'outcomeAt'
  | 'closedBy'
  | 'commissionBp'
  | 'commissionFixedCents'
  | 'commissionCurrency'
  | 'splitBp'
  | 'ownerAcceptedAt'
  | 'ownerAcceptedBy';

/** The same checks on both tables (`<table>_<name>_ck`). */
function viewingChecks(table: string, c: Record<ViewingChecked, AnyPgColumn>) {
  return [
    check(`${table}_target_ck`, sql`${c.targetKind} in ('LISTING', 'DEVELOPMENT')`),
    check(
      `${table}_status_ck`,
      sql`${c.status} in ('REQUESTED', 'SCHEDULED', 'COMPLETED', 'DECLINED', 'CANCELLED', 'EXPIRED')`,
    ),
    check(
      `${table}_awaiting_ck`,
      sql`(${c.status} = 'REQUESTED') = (${c.awaiting} is not null)
        and (${c.awaiting} is null or ${c.awaiting} in ('OWNER', 'INTRODUCER'))
        and (${c.status} <> 'REQUESTED' or ${c.expiresAt} is not null)`,
    ),
    // a viewing is scheduled only once the owner accepted the terms
    check(
      `${table}_scheduled_ck`,
      sql`${c.status} not in ('SCHEDULED', 'COMPLETED') or (${c.scheduledAt} is not null and ${c.ownerAcceptedAt} is not null)`,
    ),
    check(
      `${table}_outcome_ck`,
      sql`(${c.status} = 'COMPLETED') = (${c.outcome} is not null)
        and (${c.outcome} is null or (${c.outcome} in ('ATTENDED', 'NO_SHOW') and ${c.outcomeAt} is not null))`,
    ),
    check(
      `${table}_closed_ck`,
      sql`(${c.status} in ('DECLINED', 'CANCELLED', 'EXPIRED')) = (${c.closedBy} is not null)
        and (${c.closedBy} is null or ${c.closedBy} in ('OWNER', 'INTRODUCER', 'SYSTEM'))`,
    ),
    check(
      `${table}_terms_ck`,
      sql`(${c.commissionBp} is null) <> (${c.commissionFixedCents} is null)
        and (${c.commissionBp} is null or ${c.commissionBp} between 1 and 10000)
        and (${c.commissionFixedCents} is null
             or (${c.commissionFixedCents} between 1 and 100000000000 and ${c.commissionCurrency} is not null))
        and ${c.splitBp} between 0 and 10000`,
    ),
    check(`${table}_owner_accepted_ck`, sql`(${c.ownerAcceptedAt} is null) = (${c.ownerAcceptedBy} is null)`),
  ];
}

export const viewingRequests = pgTable(
  'viewing_requests',
  {
    id: uuid('id').primaryKey(),
    /** The introducer. */
    agencyId: uuid('agency_id').notNull(),
    /** The target's owner (its copy is `viewing_request_receipts`). */
    ownerAgencyId: uuid('owner_agency_id').notNull(),
    /** The introducer's registration of the client for the target (PLAN §3 #8 → #9). */
    registrationId: uuid('registration_id').notNull(),
    /** The introducer's crm contact (no FK across modules; a contact merge re-points it). */
    contactId: uuid('contact_id').notNull(),
    requestedByUserId: uuid('requested_by_user_id'),
    ...viewingState(),
    /** SHA-256 of the requesting member's `Idempotency-Key` and of the body (24 h replay). */
    idempotencyHash: text('idempotency_hash'),
    requestHash: text('request_hash'),
  },
  (t) => [
    // the introducer's list: where agency_id = ? and (created_ms, id) < (?, ?) order by created_ms desc, id desc
    index('viewing_requests_agency_created_idx').on(t.agencyId, t.createdMs, t.id),
    // the merge re-point: where agency_id = ? and contact_id = ?
    index('viewing_requests_contact_idx').on(t.agencyId, t.contactId),
    // the registration FK
    index('viewing_requests_registration_idx').on(t.registrationId),
    // the registration's parties and target, exactly (a request cannot name another owner or target than it)
    foreignKey({
      name: 'viewing_requests_registration_fk',
      columns: [t.registrationId, t.agencyId, t.ownerAgencyId, t.targetKind, t.targetId],
      foreignColumns: [
        clientRegistrations.id,
        clientRegistrations.agencyId,
        clientRegistrations.targetAgencyId,
        clientRegistrations.targetKind,
        clientRegistrations.targetId,
      ],
    }),
    // one open request per registration (one client, one target)
    uniqueIndex('viewing_requests_open_uq')
      .on(t.agencyId, t.registrationId)
      .where(sql`${t.status} in ('REQUESTED', 'SCHEDULED')`),
    // the expiry job: where status = 'REQUESTED' and expires_at <= now() order by expires_at
    index('viewing_requests_expiry_idx').on(t.expiresAt).where(sql`${t.status} = 'REQUESTED'`),
    // the expiry job: scheduled viewings never recorded once the terms lapse (where status = 'SCHEDULED' and
    // terms_valid_until <= now())
    index('viewing_requests_lapse_idx').on(t.termsValidUntil).where(sql`${t.status} = 'SCHEDULED'`),
    // POST replay: where agency_id = ? and idempotency_hash = ?
    uniqueIndex('viewing_requests_idempotency_uq')
      .on(t.agencyId, t.idempotencyHash)
      .where(sql`${t.idempotencyHash} is not null`),
    check('viewing_requests_owner_ck', sql`${t.ownerAgencyId} <> ${t.agencyId}`),
    ...viewingChecks('viewing_requests', t),
  ],
);

export const viewingRequestReceipts = pgTable(
  'viewing_request_receipts',
  {
    requestId: uuid('request_id').primaryKey(),
    /** The target's owner, who reads and answers it. */
    agencyId: uuid('agency_id').notNull(),
    /** The introducer ("requested by Agency X"); nothing of the client. */
    introducerAgencyId: uuid('introducer_agency_id').notNull(),
    ...viewingState(),
  },
  (t) => [
    // the owner's list: where agency_id = ? and (created_ms, request_id) < (?, ?) order by both desc
    index('viewing_request_receipts_agency_created_idx').on(t.agencyId, t.createdMs, t.requestId),
    ...viewingChecks('viewing_request_receipts', t),
  ],
);
