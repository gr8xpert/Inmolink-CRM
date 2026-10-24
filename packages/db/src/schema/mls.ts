import { type SQL, sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

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
  ],
);
