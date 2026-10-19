import type { Tx } from '@inmolink/db';
import {
  agencies,
  agencySettings,
  agencyVerificationDocuments,
  agencyVerificationRequests,
  preferredAgencies,
} from '@inmolink/db/schema/agencies';
import { and, asc, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfter, keysetOrder } from '../../pagination';

/**
 * agencies queries (PATTERNS §5). Runs as `app_user` under `withTenant` for dashboard work, and as
 * `app_auth` inside the sign-up transaction (registry `auth` predicates pin it to the new agency), and
 * as `app_staff` for verification (registry `staff` predicates). Queries only `@inmolink/db/schema/agencies`.
 */

const dtoColumns = {
  id: agencies.id,
  kind: agencies.kind,
  status: agencies.status,
  name: agencies.name,
  taxId: agencies.taxId,
  addressLine: agencies.addressLine,
  city: agencies.city,
  postalCode: agencies.postalCode,
  region: agencies.region,
  registerNumber: agencies.registerNumber,
  languages: agencies.languages,
  onboardedAt: agencies.onboardedAt,
  version: agencies.version,
  updatedAt: agencies.updatedAt,
};

/** The agency row and its settings row, created together (sign-up). */
export async function insertAgency(
  tx: Tx,
  row: { id: string; kind: 'AGENCY' | 'DEVELOPER'; name: string; enabledLocales: string[] },
): Promise<void> {
  await tx.insert(agencies).values({ id: row.id, kind: row.kind, name: row.name });
  await tx.insert(agencySettings).values({ agencyId: row.id, enabledLocales: row.enabledLocales });
}

/**
 * A repeated sign-up for an unconfirmed email takes over the agency it created, while that agency is
 * still PENDING and not onboarded. Returns false when it no longer qualifies.
 */
export async function replaceSignupAgency(
  tx: Tx,
  id: string,
  patch: { kind: 'AGENCY' | 'DEVELOPER'; name: string },
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(agencies)
    .set({ ...patch, version: sql`${agencies.version} + 1`, updatedAt: now })
    .where(and(eq(agencies.id, id), eq(agencies.status, 'PENDING'), sql`${agencies.onboardedAt} is null`))
    .returning({ id: agencies.id });
  return rows.length === 1;
}

export async function getAgency(tx: Tx, id: string) {
  const [row] = await tx.select(dtoColumns).from(agencies).where(eq(agencies.id, id));
  return row ?? null;
}

export async function getName(tx: Tx, id: string): Promise<string | null> {
  const [row] = await tx.select({ name: agencies.name }).from(agencies).where(eq(agencies.id, id));
  return row?.name ?? null;
}

/** What a request `ctx` needs about its tenant: one indexed join on the agency's primary key. */
export async function getTenantInfo(tx: Tx, id: string) {
  const [row] = await tx
    .select({ status: agencies.status, enabledLocales: agencySettings.enabledLocales })
    .from(agencies)
    .innerJoin(agencySettings, eq(agencySettings.agencyId, agencies.id))
    .where(eq(agencies.id, id));
  return row ?? null;
}

/**
 * The agency's status with a row lock (S1-05): `share` keeps staff from changing it until the caller's
 * transaction ends; `update` also serialises callers with each other (e.g. a per-agency cap check).
 */
export async function lockStatus(tx: Tx, id: string, mode: 'share' | 'update') {
  const [row] = await tx
    .select({ status: agencies.status })
    .from(agencies)
    .where(eq(agencies.id, id))
    .for(mode === 'share' ? 'share' : 'no key update');
  return row?.status ?? null;
}

/** What an edit of the company details needs to know about the current row. */
export async function getDetailsState(tx: Tx, id: string) {
  const [row] = await tx
    .select({
      status: agencies.status,
      name: agencies.name,
      taxId: agencies.taxId,
      registerNumber: agencies.registerNumber,
      onboardedAt: agencies.onboardedAt,
    })
    .from(agencies)
    .where(eq(agencies.id, id));
  return row ?? null;
}

/**
 * Company details (onboarding). Optimistic: null when `version` is stale. Sets `onboarded_at` once.
 * Name, tax id and register number change only while PENDING (the row filter re-checks name and tax
 * id; the guard trigger, migration 0020, all three).
 */
export async function updateDetails(
  tx: Tx,
  id: string,
  version: number,
  patch: {
    name: string;
    taxId: string;
    addressLine: string;
    city: string;
    postalCode: string;
    region: string;
    /** Omitted: unchanged. */
    registerNumber?: string | null;
    languages: string[];
  },
  now: Date,
) {
  const [row] = await tx
    .update(agencies)
    .set({
      ...patch,
      onboardedAt: sql`coalesce(${agencies.onboardedAt}, ${now})`,
      version: sql`${agencies.version} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(agencies.id, id),
        eq(agencies.version, version),
        or(eq(agencies.status, 'PENDING'), and(eq(agencies.name, patch.name), eq(agencies.taxId, patch.taxId))),
      ),
    )
    .returning(dtoColumns);
  return row ?? null;
}

// ── Verification (S1-03) ────────────────────────────────────────────────────────────────────────

export type RequestStatus = (typeof agencyVerificationRequests.$inferSelect)['status'];
export type DocumentKind = (typeof agencyVerificationDocuments.$inferSelect)['kind'];

const documentColumns = {
  id: agencyVerificationDocuments.id,
  requestId: agencyVerificationDocuments.requestId,
  kind: agencyVerificationDocuments.kind,
  fileName: agencyVerificationDocuments.fileName,
  contentType: agencyVerificationDocuments.contentType,
  sizeBytes: agencyVerificationDocuments.sizeBytes,
  createdAt: agencyVerificationDocuments.createdAt,
};

export interface DocumentRow {
  id: string;
  requestId: string | null;
  kind: DocumentKind;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
}

const requestColumns = {
  id: agencyVerificationRequests.id,
  agencyId: agencyVerificationRequests.agencyId,
  status: agencyVerificationRequests.status,
  detailsVersion: agencyVerificationRequests.detailsVersion,
  submittedAt: agencyVerificationRequests.submittedAt,
  reviewedVersion: agencyVerificationRequests.reviewedVersion,
  reviewerUserId: agencyVerificationRequests.reviewerUserId,
  decisionReason: agencyVerificationRequests.decisionReason,
  decidedAt: agencyVerificationRequests.decidedAt,
};

/** Documents waiting to be submitted (`request_id` null). */
export async function countUnattachedDocuments(tx: Tx, agencyId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(agencyVerificationDocuments)
    .where(and(eq(agencyVerificationDocuments.agencyId, agencyId), isNull(agencyVerificationDocuments.requestId)));
  return row?.n ?? 0;
}

export async function insertDocument(
  tx: Tx,
  row: typeof agencyVerificationDocuments.$inferInsert,
): Promise<DocumentRow> {
  const [inserted] = await tx.insert(agencyVerificationDocuments).values(row).returning(documentColumns);
  if (!inserted) throw new Error('agencies: document insert returned no row');
  return inserted;
}

export async function getDocument(tx: Tx, agencyId: string, id: string) {
  const [row] = await tx
    .select({ requestId: agencyVerificationDocuments.requestId, storageKey: agencyVerificationDocuments.storageKey })
    .from(agencyVerificationDocuments)
    .where(and(eq(agencyVerificationDocuments.agencyId, agencyId), eq(agencyVerificationDocuments.id, id)));
  return row ?? null;
}

/** Deletes an unattached document; null when it was attached meanwhile (or is gone). */
export async function deleteUnattachedDocument(tx: Tx, agencyId: string, id: string): Promise<string | null> {
  const [row] = await tx
    .delete(agencyVerificationDocuments)
    .where(
      and(
        eq(agencyVerificationDocuments.agencyId, agencyId),
        eq(agencyVerificationDocuments.id, id),
        isNull(agencyVerificationDocuments.requestId),
      ),
    )
    .returning({ storageKey: agencyVerificationDocuments.storageKey });
  return row?.storageKey ?? null;
}

/** Unattached documents, then those of `requestId` — oldest first; bounded (uploads are capped). */
export async function listAgencyDocuments(tx: Tx, agencyId: string, requestId: string | null): Promise<DocumentRow[]> {
  return tx
    .select(documentColumns)
    .from(agencyVerificationDocuments)
    .where(
      and(
        eq(agencyVerificationDocuments.agencyId, agencyId),
        requestId
          ? or(isNull(agencyVerificationDocuments.requestId), eq(agencyVerificationDocuments.requestId, requestId))
          : isNull(agencyVerificationDocuments.requestId),
      ),
    )
    .orderBy(asc(agencyVerificationDocuments.createdAt), asc(agencyVerificationDocuments.id))
    .limit(100);
}

export async function listRequestDocuments(tx: Tx, requestId: string): Promise<DocumentRow[]> {
  return tx
    .select(documentColumns)
    .from(agencyVerificationDocuments)
    .where(eq(agencyVerificationDocuments.requestId, requestId))
    .orderBy(asc(agencyVerificationDocuments.createdAt), asc(agencyVerificationDocuments.id))
    .limit(100);
}

export async function getRequestDocument(tx: Tx, requestId: string, id: string) {
  const [row] = await tx
    .select({ storageKey: agencyVerificationDocuments.storageKey, fileName: agencyVerificationDocuments.fileName })
    .from(agencyVerificationDocuments)
    .where(and(eq(agencyVerificationDocuments.requestId, requestId), eq(agencyVerificationDocuments.id, id)));
  return row ?? null;
}

/** The agency's most recent request (index `agency_verification_requests_agency_idx`). */
export async function getLatestRequest(tx: Tx, agencyId: string) {
  const [row] = await tx
    .select(requestColumns)
    .from(agencyVerificationRequests)
    .where(eq(agencyVerificationRequests.agencyId, agencyId))
    .orderBy(desc(agencyVerificationRequests.submittedAt))
    .limit(1);
  return row ?? null;
}

export async function insertRequest(
  tx: Tx,
  row: { id: string; agencyId: string; detailsVersion: number; submittedBy: string; submittedAt: Date },
): Promise<void> {
  await tx.insert(agencyVerificationRequests).values(row);
}

/** Attaches every unattached document to the new request. Returns how many. */
export async function attachDocuments(tx: Tx, agencyId: string, requestId: string): Promise<number> {
  const rows = await tx
    .update(agencyVerificationDocuments)
    .set({ requestId })
    .where(and(eq(agencyVerificationDocuments.agencyId, agencyId), isNull(agencyVerificationDocuments.requestId)))
    .returning({ id: agencyVerificationDocuments.id });
  return rows.length;
}

/** Staff queue: one status, oldest submission first, keyset on `(submitted_at, id)`. */
export async function listQueue(tx: Tx, q: { status: RequestStatus; limit: number; cursor?: KeysetCursor }) {
  return tx
    .select({
      id: agencyVerificationRequests.id,
      status: agencyVerificationRequests.status,
      submittedAt: agencyVerificationRequests.submittedAt,
      decidedAt: agencyVerificationRequests.decidedAt,
      agencyId: agencies.id,
      agencyName: agencies.name,
      agencyKind: agencies.kind,
      taxId: agencies.taxId,
    })
    .from(agencyVerificationRequests)
    .innerJoin(agencies, eq(agencies.id, agencyVerificationRequests.agencyId))
    .where(
      and(
        eq(agencyVerificationRequests.status, q.status),
        keysetAfter(agencyVerificationRequests.submittedAt, agencyVerificationRequests.id, q.cursor, 'asc'),
      ),
    )
    .orderBy(...keysetOrder(agencyVerificationRequests.submittedAt, agencyVerificationRequests.id, 'asc'))
    .limit(q.limit + 1);
}

export async function getRequest(tx: Tx, id: string, options: { forUpdate?: boolean } = {}) {
  const query = tx.select(requestColumns).from(agencyVerificationRequests).where(eq(agencyVerificationRequests.id, id));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row ?? null;
}

/** Staff decision on an open request (the guard trigger re-checks every column rule). */
export async function decideRequest(
  tx: Tx,
  id: string,
  decision: {
    status: 'APPROVED' | 'REJECTED';
    reviewerUserId: string;
    reviewedVersion: number;
    reason: string;
    now: Date;
  },
): Promise<boolean> {
  const rows = await tx
    .update(agencyVerificationRequests)
    .set({
      status: decision.status,
      reviewerUserId: decision.reviewerUserId,
      reviewedVersion: decision.reviewedVersion,
      decisionReason: decision.reason,
      decidedAt: decision.now,
      updatedAt: decision.now,
    })
    .where(and(eq(agencyVerificationRequests.id, id), eq(agencyVerificationRequests.status, 'SUBMITTED')))
    .returning({ id: agencyVerificationRequests.id });
  return rows.length === 1;
}

/**
 * Staff status change bound to the details `version` they reviewed: null when the agency changed
 * since (or is no longer in `from`). Bumps `version`, so later edits are told apart.
 */
export async function changeStatus(
  tx: Tx,
  id: string,
  change: { from: 'PENDING'; to: 'VERIFIED'; version: number; now: Date },
): Promise<{ version: number } | null> {
  const [row] = await tx
    .update(agencies)
    .set({ status: change.to, version: sql`${agencies.version} + 1`, updatedAt: change.now })
    .where(and(eq(agencies.id, id), eq(agencies.status, change.from), eq(agencies.version, change.version)))
    .returning({ version: agencies.version });
  return row ?? null;
}

/** For the decision email job (`app_system`): what was decided and why. */
export async function getDecision(tx: Tx, requestId: string) {
  const [row] = await tx
    .select({
      agencyId: agencyVerificationRequests.agencyId,
      status: agencyVerificationRequests.status,
      reason: agencyVerificationRequests.decisionReason,
      agencyName: agencies.name,
    })
    .from(agencyVerificationRequests)
    .innerJoin(agencies, eq(agencies.id, agencyVerificationRequests.agencyId))
    .where(eq(agencyVerificationRequests.id, requestId));
  return row ?? null;
}

/** Serialises the document cap per agency until the transaction ends (advisory, no table lock). */
export async function lockDocumentCap(tx: Tx, agencyId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`verification_documents:${agencyId}`}, 0))`);
}

/** A document with the same content that waits to be submitted: a retried upload finds it again. */
export async function findUnattachedBySha(tx: Tx, agencyId: string, sha256: string): Promise<DocumentRow | null> {
  const [row] = await tx
    .select(documentColumns)
    .from(agencyVerificationDocuments)
    .where(
      and(
        eq(agencyVerificationDocuments.agencyId, agencyId),
        eq(agencyVerificationDocuments.sha256, sha256),
        isNull(agencyVerificationDocuments.requestId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Maintenance (`app_system`): which of these storage keys still have a document row. */
export async function existingStorageKeys(tx: Tx, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await tx
    .select({ key: agencyVerificationDocuments.storageKey })
    .from(agencyVerificationDocuments)
    .where(inArray(agencyVerificationDocuments.storageKey, keys));
  return new Set(rows.map((r) => r.key));
}

/** The content locales of these agencies (`agency_settings` PK; read models, S5-01). */
export async function readModelOwners(tx: Tx, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return tx
    .select({
      agencyId: agencySettings.agencyId,
      locales: agencySettings.enabledLocales,
      verified: sql<boolean>`${agencies.status} = 'VERIFIED'`,
      // S6-F2: the agencies it prefers (≤ MAX_PREFERRED_AGENCIES, PK range), on its PREFERRED listings' documents.
      preferred: sql<string[]>`array(select p.preferred_agency_id::text from ${preferredAgencies} p
        where p.agency_id = ${agencySettings.agencyId} order by 1)`,
    })
    .from(agencySettings)
    .innerJoin(agencies, eq(agencies.id, agencySettings.agencyId))
    .where(inArray(agencySettings.agencyId, [...ids]));
}
