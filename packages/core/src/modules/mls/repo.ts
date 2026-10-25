/**
 * mls queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/mls` — other modules' tables fail `pnpm check:boundaries`.
 */

import type { RegistrationState, RegistrationTargetKind } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import {
  clientRegistrationFingerprints,
  clientRegistrationReceipts,
  clientRegistrations,
} from '@inmolink/db/schema/mls';
import { type AnyColumn, and, asc, desc, eq, gt, inArray, type SQL, sql } from 'drizzle-orm';
import { type KeysetCursor, rowAfter } from '../../pagination';

/**
 * S11-06 filters of the collaborations view (all optional): state by the database's clock, target kind, and a day range
 * whose edges are midnights in the agency's time zone (`timeZone`, set whenever `from` or `to` is).
 */
export interface RegistrationFilter {
  state?: RegistrationState | undefined;
  kind?: RegistrationTargetKind | undefined;
  from?: string | undefined;
  to?: string | undefined;
  timeZone?: string | undefined;
}

function filterWhere(
  f: RegistrationFilter | undefined,
  c: { kind: AnyColumn; expiresAt: AnyColumn; ms: AnyColumn },
): (SQL | undefined)[] {
  if (!f) return [];
  return [
    f.kind ? sql`${c.kind} = ${f.kind}` : undefined,
    f.state === 'ACTIVE' ? sql`${c.expiresAt} > now()` : undefined,
    f.state === 'EXPIRED' ? sql`${c.expiresAt} <= now()` : undefined,
    f.from ? sql`${c.ms} >= (${f.from}::date)::timestamp at time zone ${f.timeZone}` : undefined,
    f.to ? sql`${c.ms} < ((${f.to}::date + 1))::timestamp at time zone ${f.timeZone}` : undefined,
  ];
}

export interface NewRegistration {
  id: string;
  agencyId: string;
  targetAgencyId: string;
  targetKind: string;
  targetId: string;
  /** The introducer's validity; the receipt trigger caps it at the owner's. */
  validityDays: number;
  contactId: string;
  registeredByUserId: string | null;
  detailsEnc: string;
  fingerprints: readonly string[];
}

/**
 * The registration and one fingerprint row per fingerprint, in one statement (a data-modifying CTE): `registered_at` is
 * the database's `now()`, `expires_at` the introducer's validity capped by the owner's (`client_registrations_receipt`,
 * which also appends the owner's receipt). Fails with 23P01 (`client_registration_fingerprints_valid_ex`) when another
 * valid registration of the same client for the same target exists — any agency's.
 */
export async function insertRegistration(tx: Tx, r: NewRegistration): Promise<{ registeredAt: Date; expiresAt: Date }> {
  const res = await tx.execute(sql`
    with reg as (
      insert into ${clientRegistrations}
        (id, agency_id, target_agency_id, target_kind, target_id, contact_id, registered_by_user_id, details_enc, expires_at)
      values (${r.id}, ${r.agencyId}, ${r.targetAgencyId}, ${r.targetKind}, ${r.targetId}, ${r.contactId},
              ${r.registeredByUserId}, ${r.detailsEnc}, now() + make_interval(days => ${r.validityDays}::int))
      returning registered_at, expires_at
    ), prints as (
      insert into ${clientRegistrationFingerprints}
        (registration_id, agency_id, target_id, fingerprint, registered_at, expires_at)
      select ${r.id}, ${r.agencyId}, ${r.targetId}, f, reg.registered_at, reg.expires_at
        from reg, unnest(${sql`array[${sql.join(
          r.fingerprints.map((f) => sql`${f}`),
          sql`, `,
        )}]::text[]`}) as f
      returning 1
    )
    select registered_at, expires_at, (select count(*) from prints)::int as prints from reg`);
  const row = res.rows[0] as { registered_at: string | Date; expires_at: string | Date };
  return { registeredAt: new Date(row.registered_at), expiresAt: new Date(row.expires_at) };
}

/** The agency's own registration of any of these fingerprints for the target, still valid now (one statement). */
export async function findOwnValid(
  tx: Tx,
  agencyId: string,
  targetId: string,
  fingerprints: readonly string[],
): Promise<string | null> {
  const [row] = await tx
    .select({ id: clientRegistrationFingerprints.registrationId })
    .from(clientRegistrationFingerprints)
    .where(
      and(
        eq(clientRegistrationFingerprints.agencyId, agencyId),
        eq(clientRegistrationFingerprints.targetId, targetId),
        inArray(clientRegistrationFingerprints.fingerprint, [...fingerprints]),
        gt(clientRegistrationFingerprints.expiresAt, sql`now()`),
      ),
    )
    .orderBy(clientRegistrationFingerprints.registeredAt)
    .limit(1);
  return row?.id ?? null;
}

const ownColumns = {
  id: clientRegistrations.id,
  targetAgencyId: clientRegistrations.targetAgencyId,
  targetKind: clientRegistrations.targetKind,
  targetId: clientRegistrations.targetId,
  contactId: clientRegistrations.contactId,
  registeredByUserId: clientRegistrations.registeredByUserId,
  detailsEnc: clientRegistrations.detailsEnc,
  registeredAt: clientRegistrations.registeredAt,
  expiresAt: clientRegistrations.expiresAt,
  registeredMs: clientRegistrations.registeredMs,
  active: sql<boolean>`(${clientRegistrations.expiresAt} > now())`,
};
export interface OwnRegistrationRow {
  /** Still valid by the database's clock. */
  active: boolean;
  id: string;
  targetAgencyId: string;
  targetKind: string;
  targetId: string;
  contactId: string;
  registeredByUserId: string | null;
  detailsEnc: string;
  registeredAt: Date;
  expiresAt: Date;
  registeredMs: Date;
}

export async function getOwn(tx: Tx, agencyId: string, id: string): Promise<OwnRegistrationRow | null> {
  const [row] = await tx
    .select(ownColumns)
    .from(clientRegistrations)
    .where(and(eq(clientRegistrations.agencyId, agencyId), eq(clientRegistrations.id, id)));
  return row ?? null;
}

/**
 * The introducer's registrations, newest first: one table under one policy, an index-ordered keyset page
 * (`client_registrations_agency_registered_idx`); limit + 1 rows, one statement.
 */
export function ownPage(
  tx: Tx,
  agencyId: string,
  page: { limit: number; cursor?: KeysetCursor; filter?: RegistrationFilter },
) {
  return tx
    .select(ownColumns)
    .from(clientRegistrations)
    .where(
      and(
        eq(clientRegistrations.agencyId, agencyId),
        rowAfter(clientRegistrations.registeredMs, clientRegistrations.id, page.cursor),
        ...filterWhere(page.filter, {
          kind: clientRegistrations.targetKind,
          expiresAt: clientRegistrations.expiresAt,
          ms: clientRegistrations.registeredMs,
        }),
      ),
    )
    .orderBy(desc(clientRegistrations.registeredMs), desc(clientRegistrations.id))
    .limit(page.limit + 1);
}

export async function listOwn(
  tx: Tx,
  agencyId: string,
  page: { limit: number; cursor?: KeysetCursor; filter?: RegistrationFilter },
): Promise<OwnRegistrationRow[]> {
  return ownPage(tx, agencyId, page);
}

export interface ReceiptRow {
  active: boolean;
  registrationId: string;
  introducerAgencyId: string;
  targetKind: string;
  targetId: string;
  registeredAt: Date;
  expiresAt: Date;
  registeredMs: Date;
}

/**
 * The owner's receipts — registrations other agencies made for its targets — newest first
 * (`client_registration_receipts_agency_registered_idx`). Nothing of the client exists in them.
 */
export function receiptsPage(
  tx: Tx,
  agencyId: string,
  page: { limit: number; cursor?: KeysetCursor; filter?: RegistrationFilter },
) {
  return tx
    .select({
      registrationId: clientRegistrationReceipts.registrationId,
      introducerAgencyId: clientRegistrationReceipts.introducerAgencyId,
      targetKind: clientRegistrationReceipts.targetKind,
      targetId: clientRegistrationReceipts.targetId,
      registeredAt: clientRegistrationReceipts.registeredAt,
      expiresAt: clientRegistrationReceipts.expiresAt,
      registeredMs: clientRegistrationReceipts.registeredMs,
      active: sql<boolean>`(${clientRegistrationReceipts.expiresAt} > now())`,
    })
    .from(clientRegistrationReceipts)
    .where(
      and(
        eq(clientRegistrationReceipts.agencyId, agencyId),
        rowAfter(clientRegistrationReceipts.registeredMs, clientRegistrationReceipts.registrationId, page.cursor),
        ...filterWhere(page.filter, {
          kind: clientRegistrationReceipts.targetKind,
          expiresAt: clientRegistrationReceipts.expiresAt,
          ms: clientRegistrationReceipts.registeredMs,
        }),
      ),
    )
    .orderBy(desc(clientRegistrationReceipts.registeredMs), desc(clientRegistrationReceipts.registrationId))
    .limit(page.limit + 1);
}

export async function listReceipts(
  tx: Tx,
  agencyId: string,
  page: { limit: number; cursor?: KeysetCursor; filter?: RegistrationFilter },
): Promise<ReceiptRow[]> {
  return receiptsPage(tx, agencyId, page);
}

/** A contact merge: the agency's registrations of `fromId` name `toId` (one statement; idempotent). */
export async function repointContact(tx: Tx, agencyId: string, fromId: string, toId: string): Promise<number> {
  const rows = await tx
    .update(clientRegistrations)
    .set({ contactId: toId })
    .where(and(eq(clientRegistrations.agencyId, agencyId), eq(clientRegistrations.contactId, fromId)))
    .returning({ id: clientRegistrations.id });
  return rows.length;
}

// ---- HMAC rotation and retention (worker, app_system) ----------------------------------------------------------------

/** Agencies with registrations still valid (the rehash fan-out), after `afterAgencyId`, up to `limit`. */
export async function agenciesWithValid(tx: Tx, afterAgencyId: string | null, limit: number): Promise<string[]> {
  const res = await tx.execute(sql`
    select distinct agency_id from ${clientRegistrations}
     where expires_at > now() ${afterAgencyId ? sql`and agency_id > ${afterAgencyId}` : sql``}
     order by agency_id limit ${limit}`);
  return (res.rows as { agency_id: string }[]).map((r) => r.agency_id);
}

export interface ValidRegistration {
  id: string;
  targetId: string;
  detailsEnc: string;
  registeredAt: Date;
  expiresAt: Date;
}

/** A batch of the agency's registrations still valid, by id (`client_registrations_agency_expires_idx` filters). */
export async function validBatch(
  tx: Tx,
  agencyId: string,
  afterId: string | null,
  limit: number,
): Promise<ValidRegistration[]> {
  return tx
    .select({
      id: clientRegistrations.id,
      targetId: clientRegistrations.targetId,
      detailsEnc: clientRegistrations.detailsEnc,
      registeredAt: clientRegistrations.registeredAt,
      expiresAt: clientRegistrations.expiresAt,
    })
    .from(clientRegistrations)
    .where(
      and(
        eq(clientRegistrations.agencyId, agencyId),
        gt(clientRegistrations.expiresAt, sql`now()`),
        afterId ? gt(clientRegistrations.id, afterId) : undefined,
      ),
    )
    .orderBy(asc(clientRegistrations.id))
    .limit(limit);
}

/**
 * Adds fingerprints to the agency's registrations (one statement), with each registration's own target and validity
 * copied in SQL (the FK compares them at microsecond precision); rows already there are skipped (`on conflict do
 * nothing`: the primary key, and the exclusion constraint).
 */
export async function addFingerprints(
  tx: Tx,
  agencyId: string,
  rows: readonly { registrationId: string; fingerprint: string }[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const ids = sql.join(
    rows.map((r) => sql`${r.registrationId}`),
    sql`, `,
  );
  const prints = sql.join(
    rows.map((r) => sql`${r.fingerprint}`),
    sql`, `,
  );
  const res = await tx.execute(sql`
    insert into ${clientRegistrationFingerprints}
      (registration_id, agency_id, target_id, fingerprint, registered_at, expires_at)
    select r.id, r.agency_id, r.target_id, v.fingerprint, r.registered_at, r.expires_at
      from unnest(array[${ids}]::uuid[], array[${prints}]::text[]) as v(registration_id, fingerprint)
      join ${clientRegistrations} r on r.agency_id = ${agencyId} and r.id = v.registration_id
    on conflict do nothing`);
  return res.rowCount ?? 0;
}

/** Retention: deletes up to `limit` fingerprints that expired before `before` (they block nothing any more). */
export async function pruneExpiredFingerprints(tx: Tx, before: Date, limit: number): Promise<number> {
  const res = await tx.execute(sql`
    delete from ${clientRegistrationFingerprints} f
     using (select agency_id, registration_id, fingerprint from ${clientRegistrationFingerprints}
             where expires_at < ${before.toISOString()}::timestamptz limit ${limit}) d
     where f.agency_id = d.agency_id and f.registration_id = d.registration_id and f.fingerprint = d.fingerprint`);
  return res.rowCount ?? 0;
}
