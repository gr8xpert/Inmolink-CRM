/**
 * mls viewing-request queries (S11-02, PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Each side reads and writes its own table only (`viewing_requests` the introducer, `viewing_request_receipts` the
 * owner); the definer triggers copy the shared state to the other side's row.
 */
import type { RegistrationTargetKind, ViewingStatus } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { clientRegistrations, viewingRequestReceipts, viewingRequests } from '@inmolink/db/schema/mls';
import { type AnyColumn, and, desc, eq, gt, type SQL, sql } from 'drizzle-orm';
import type { KeysetCursor } from '../../pagination';

export type Side = 'INTRODUCER' | 'OWNER';

/** One side's row, in one shape for both tables. */
export interface ViewingRow {
  id: string;
  side: Side;
  introducerAgencyId: string;
  ownerAgencyId: string;
  /** Introducer only. */
  registrationId: string | null;
  contactId: string | null;
  requestedByUserId: string | null;
  targetKind: string;
  targetId: string;
  status: string;
  awaiting: string | null;
  proposedStartAt: Date;
  scheduledAt: Date | null;
  expiresAt: Date | null;
  outcome: string | null;
  outcomeAt: Date | null;
  closedBy: string | null;
  commissionBp: number | null;
  commissionFixedCents: number | null;
  commissionCurrency: string | null;
  splitBp: number;
  commissionIncludesVat: boolean;
  termsValidUntil: Date;
  termsAt: Date;
  introducerAcceptedAt: Date;
  introducerAcceptedBy: string | null;
  ownerAcceptedAt: Date | null;
  ownerAcceptedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdMs: Date;
  /** `REQUESTED` and past its expiry by the database's clock (the job may not have closed it yet). */
  lapsed: boolean;
  /** The scheduled time has come, by the database's clock. */
  due: boolean;
}

const shared = (t: typeof viewingRequests | typeof viewingRequestReceipts) => ({
  targetKind: t.targetKind,
  targetId: t.targetId,
  status: t.status,
  awaiting: t.awaiting,
  proposedStartAt: t.proposedStartAt,
  scheduledAt: t.scheduledAt,
  expiresAt: t.expiresAt,
  outcome: t.outcome,
  outcomeAt: t.outcomeAt,
  closedBy: t.closedBy,
  commissionBp: t.commissionBp,
  commissionFixedCents: t.commissionFixedCents,
  commissionCurrency: t.commissionCurrency,
  splitBp: t.splitBp,
  commissionIncludesVat: t.commissionIncludesVat,
  termsValidUntil: t.termsValidUntil,
  termsAt: t.termsAt,
  introducerAcceptedAt: t.introducerAcceptedAt,
  introducerAcceptedBy: t.introducerAcceptedBy,
  ownerAcceptedAt: t.ownerAcceptedAt,
  ownerAcceptedBy: t.ownerAcceptedBy,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
  createdMs: t.createdMs,
  lapsed: sql<boolean>`(${t.status} = 'REQUESTED' and ${t.expiresAt} <= now())`,
  due: sql<boolean>`(${t.scheduledAt} is not null and ${t.scheduledAt} <= now())`,
});

const introducerColumns = {
  id: viewingRequests.id,
  introducerAgencyId: viewingRequests.agencyId,
  ownerAgencyId: viewingRequests.ownerAgencyId,
  registrationId: viewingRequests.registrationId,
  contactId: viewingRequests.contactId,
  requestedByUserId: viewingRequests.requestedByUserId,
  ...shared(viewingRequests),
};

const ownerColumns = {
  id: viewingRequestReceipts.requestId,
  introducerAgencyId: viewingRequestReceipts.introducerAgencyId,
  ownerAgencyId: viewingRequestReceipts.agencyId,
  ...shared(viewingRequestReceipts),
};

/** S11-06 filters of the collaborations view (all optional): status, target kind, creation day range in `timeZone`. */
export interface ViewingFilter {
  status?: ViewingStatus | undefined;
  kind?: RegistrationTargetKind | undefined;
  from?: string | undefined;
  to?: string | undefined;
  timeZone?: string | undefined;
}

type SharedTable = typeof viewingRequests | typeof viewingRequestReceipts;
const filterWhere = (f: ViewingFilter | undefined, t: SharedTable): (SQL | undefined)[] =>
  f
    ? [
        f.status ? sql`${t.status} = ${f.status}` : undefined,
        f.kind ? sql`${t.targetKind} = ${f.kind}` : undefined,
        f.from ? sql`${t.createdMs} >= (${f.from}::date)::timestamp at time zone ${f.timeZone}` : undefined,
        f.to ? sql`${t.createdMs} < ((${f.to}::date + 1))::timestamp at time zone ${f.timeZone}` : undefined,
      ]
    : [];

const asIntroducer = (r: Omit<ViewingRow, 'side'>): ViewingRow => ({ ...r, side: 'INTRODUCER' });
const asOwner = (r: Omit<ViewingRow, 'side' | 'registrationId' | 'contactId' | 'requestedByUserId'>): ViewingRow => ({
  ...r,
  side: 'OWNER',
  registrationId: null,
  contactId: null,
  requestedByUserId: null,
});

/** Newest first on the stored millisecond column and the id, the cursor as one row comparison (index condition). */
function rowAfter(ms: AnyColumn, id: AnyColumn, cursor: KeysetCursor | undefined): SQL | undefined {
  if (!cursor) return undefined;
  return sql`(${ms}, ${id}) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`;
}

// ---- reads -------------------------------------------------------------------------------------------------------------

/** The agency's own registration, still valid now (a viewing request's link to S11-01). */
export async function validRegistration(tx: Tx, agencyId: string, id: string) {
  const [row] = await tx
    .select({
      id: clientRegistrations.id,
      targetAgencyId: clientRegistrations.targetAgencyId,
      targetKind: clientRegistrations.targetKind,
      targetId: clientRegistrations.targetId,
      contactId: clientRegistrations.contactId,
      expiresAt: clientRegistrations.expiresAt,
    })
    .from(clientRegistrations)
    .where(
      and(
        eq(clientRegistrations.agencyId, agencyId),
        eq(clientRegistrations.id, id),
        gt(clientRegistrations.expiresAt, sql`now()`),
      ),
    );
  return row ?? null;
}

/** The request as the caller's side holds it: the introducer's row, else the owner's copy (RLS shows at most one). */
export async function sideRow(tx: Tx, agencyId: string, id: string): Promise<ViewingRow | null> {
  const [mine] = await tx
    .select(introducerColumns)
    .from(viewingRequests)
    .where(and(eq(viewingRequests.agencyId, agencyId), eq(viewingRequests.id, id)));
  if (mine) return asIntroducer(mine);
  const [theirs] = await tx
    .select(ownerColumns)
    .from(viewingRequestReceipts)
    .where(and(eq(viewingRequestReceipts.agencyId, agencyId), eq(viewingRequestReceipts.requestId, id)));
  return theirs ? asOwner(theirs) : null;
}

/** The introducer's requests, newest first (`viewing_requests_agency_created_idx`), limit + 1 rows: the statement. */
export function introducerPageQuery(
  tx: Tx,
  agencyId: string,
  page: { limit: number; cursor?: KeysetCursor; filter?: ViewingFilter },
) {
  return tx
    .select(introducerColumns)
    .from(viewingRequests)
    .where(
      and(
        eq(viewingRequests.agencyId, agencyId),
        rowAfter(viewingRequests.createdMs, viewingRequests.id, page.cursor),
        ...filterWhere(page.filter, viewingRequests),
      ),
    )
    .orderBy(desc(viewingRequests.createdMs), desc(viewingRequests.id))
    .limit(page.limit + 1);
}

export async function introducerPage(
  tx: Tx,
  agencyId: string,
  page: { limit: number; cursor?: KeysetCursor; filter?: ViewingFilter },
): Promise<ViewingRow[]> {
  return (await introducerPageQuery(tx, agencyId, page)).map(asIntroducer);
}

/** The owner's copies, newest first (`viewing_request_receipts_agency_created_idx`), limit + 1 rows: the statement. */
export function ownerPageQuery(
  tx: Tx,
  agencyId: string,
  page: { limit: number; cursor?: KeysetCursor; filter?: ViewingFilter },
) {
  return tx
    .select(ownerColumns)
    .from(viewingRequestReceipts)
    .where(
      and(
        eq(viewingRequestReceipts.agencyId, agencyId),
        rowAfter(viewingRequestReceipts.createdMs, viewingRequestReceipts.requestId, page.cursor),
        ...filterWhere(page.filter, viewingRequestReceipts),
      ),
    )
    .orderBy(desc(viewingRequestReceipts.createdMs), desc(viewingRequestReceipts.requestId))
    .limit(page.limit + 1);
}

export async function ownerPage(
  tx: Tx,
  agencyId: string,
  page: { limit: number; cursor?: KeysetCursor; filter?: ViewingFilter },
): Promise<ViewingRow[]> {
  return (await ownerPageQuery(tx, agencyId, page)).map(asOwner);
}

/** A replay of the member's `Idempotency-Key` within the window. */
export async function requestByIdempotency(
  tx: Tx,
  agencyId: string,
  hash: string,
  since: Date,
): Promise<{ row: ViewingRow; requestHash: string | null } | null> {
  const [row] = await tx
    .select({ ...introducerColumns, requestHash: viewingRequests.requestHash })
    .from(viewingRequests)
    .where(
      and(
        eq(viewingRequests.agencyId, agencyId),
        eq(viewingRequests.idempotencyHash, hash),
        gt(viewingRequests.createdAt, since),
      ),
    );
  if (!row) return null;
  const { requestHash, ...rest } = row;
  return { row: asIntroducer(rest), requestHash };
}

// ---- writes ------------------------------------------------------------------------------------------------------------

export interface NewViewingRequest {
  id: string;
  agencyId: string;
  ownerAgencyId: string;
  registrationId: string;
  contactId: string;
  requestedByUserId: string | null;
  targetKind: string;
  targetId: string;
  proposedStartAt: Date;
  expiresAt: Date;
  commissionBp: number | null;
  commissionFixedCents: number | null;
  commissionCurrency: string | null;
  splitBp: number;
  commissionIncludesVat: boolean;
  termsValidUntil: Date;
  idempotencyHash: string | null;
  requestHash: string | null;
}

/**
 * The introducer's request (one statement); its trigger appends the owner's copy. Fails with 23505 on
 * `viewing_requests_open_uq` (an open request of the registration) or `viewing_requests_idempotency_uq`.
 */
export async function insertRequest(tx: Tx, r: NewViewingRequest): Promise<ViewingRow> {
  const [row] = await tx
    .insert(viewingRequests)
    .values({
      ...r,
      status: 'REQUESTED',
      awaiting: 'OWNER',
      introducerAcceptedBy: r.requestedByUserId,
    })
    .returning(introducerColumns);
  if (!row) throw new Error('mls: viewing request insert returned no row');
  return asIntroducer(row);
}

/** What a transition changes on the caller's row (the shared state; the owner's acceptance from the owner's row only). */
export interface ViewingPatch {
  status: string;
  awaiting: string | null;
  proposedStartAt?: Date;
  scheduledAt?: Date | null;
  expiresAt?: Date | null;
  outcome?: string | null;
  outcomeAt?: Date | null;
  closedBy?: string | null;
  /** The owner's acceptance of the terms (owner side only: app_user cannot write it on the introducer's row). */
  ownerAccept?: { userId: string };
}

/**
 * Updates the caller's own row if its status is still the one read (one statement); the sync trigger copies it to the
 * other side's. Null when the status moved meanwhile (the expiry job, which skips locked requests, got there first).
 */
export async function updateSide(
  tx: Tx,
  agencyId: string,
  row: ViewingRow,
  patch: ViewingPatch,
): Promise<ViewingRow | null> {
  const { ownerAccept, ...rest } = patch;
  const set = { ...rest, updatedAt: sql`now()` };
  if (row.side === 'INTRODUCER') {
    if (ownerAccept) throw new Error('mls: the owner accepts on its own row');
    const [out] = await tx
      .update(viewingRequests)
      .set(set)
      .where(
        and(
          eq(viewingRequests.agencyId, agencyId),
          eq(viewingRequests.id, row.id),
          eq(viewingRequests.status, row.status),
        ),
      )
      .returning(introducerColumns);
    return out ? asIntroducer(out) : null;
  }
  const [out] = await tx
    .update(viewingRequestReceipts)
    .set(ownerAccept ? { ...set, ownerAcceptedAt: sql`now()`, ownerAcceptedBy: ownerAccept.userId } : set)
    .where(
      and(
        eq(viewingRequestReceipts.agencyId, agencyId),
        eq(viewingRequestReceipts.requestId, row.id),
        eq(viewingRequestReceipts.status, row.status),
      ),
    )
    .returning(ownerColumns);
  return out ? asOwner(out) : null;
}

/** A contact merge: the agency's viewing requests of `fromId` name `toId` (one statement; idempotent). */
export async function repointContact(tx: Tx, agencyId: string, fromId: string, toId: string): Promise<number> {
  const rows = await tx
    .update(viewingRequests)
    .set({ contactId: toId })
    .where(and(eq(viewingRequests.agencyId, agencyId), eq(viewingRequests.contactId, fromId)))
    .returning({ id: viewingRequests.id });
  return rows.length;
}

// ---- the expiry job (worker, app_system) --------------------------------------------------------------------------------

export interface ExpiredRequest {
  id: string;
  introducerAgencyId: string;
  ownerAgencyId: string;
}

/**
 * Closes up to `limit` requests as `EXPIRED` (`closed_by = SYSTEM`) in one statement: unanswered proposals past their
 * expiry (`viewing_requests_expiry_idx`) and scheduled viewings nobody recorded before the terms lapsed
 * (`viewing_requests_lapse_idx`) — so the registration's open-request slot frees up. Fair share: at most `perAgency`
 * per introducer agency a batch. Each takes the request's advisory lock (`pg_try_advisory_xact_lock`, the transitions'
 * key) and its row lock (`skip locked`): a request being answered right now is left to its answer, and no lock order
 * can deadlock with a transition. The sync trigger closes the owner's copy.
 */
export async function expireDue(tx: Tx, limit: number, perAgency: number): Promise<ExpiredRequest[]> {
  const res = await tx.execute(sql`
    with candidates as (
      (select id, agency_id, expires_at as due_at from ${viewingRequests}
        where status = 'REQUESTED' and expires_at <= now() order by expires_at limit ${limit * 4})
      union all
      (select id, agency_id, terms_valid_until as due_at from ${viewingRequests}
        where status = 'SCHEDULED' and terms_valid_until <= now() order by terms_valid_until limit ${limit * 4})
    ), ranked as (
      select id, due_at, row_number() over (partition by agency_id order by due_at, id) as rn from candidates
    ), picked as (
      select id from ranked where rn <= ${perAgency} order by due_at, id limit ${limit}
    ), locked as (
      select v.id from ${viewingRequests} v join picked p on p.id = v.id
       where v.status in ('REQUESTED', 'SCHEDULED')
         and pg_try_advisory_xact_lock(hashtextextended('mls.viewing:' || v.id::text, 0))
       for update of v skip locked
    )
    update ${viewingRequests} v
       set status = 'EXPIRED', awaiting = null, closed_by = 'SYSTEM', updated_at = now()
      from locked where v.id = locked.id
    returning v.id, v.agency_id, v.owner_agency_id`);
  return (res.rows as { id: string; agency_id: string; owner_agency_id: string }[]).map((r) => ({
    id: r.id,
    introducerAgencyId: r.agency_id,
    ownerAgencyId: r.owner_agency_id,
  }));
}

/** A viewing request as the worker reads it (app_system): both parties and who asked for it. */
export async function forNotice(tx: Tx, id: string) {
  const [row] = await tx
    .select({
      id: viewingRequests.id,
      introducerAgencyId: viewingRequests.agencyId,
      ownerAgencyId: viewingRequests.ownerAgencyId,
      requestedByUserId: viewingRequests.requestedByUserId,
      targetKind: viewingRequests.targetKind,
      targetId: viewingRequests.targetId,
      status: viewingRequests.status,
    })
    .from(viewingRequests)
    .where(eq(viewingRequests.id, id));
  return row ?? null;
}
