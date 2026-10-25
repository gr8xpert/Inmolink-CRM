import type { Tx } from '@inmolink/db';
import { contacts, sellerProspects } from '@inmolink/db/schema/crm';
import { and, asc, eq, gt, gte, isNull, lt, type SQL, sql } from 'drizzle-orm';
import { type KeysetCursor, rowAfter, rowOrder } from '../../pagination';

/**
 * Seller prospect queries (S10-07, the acquisition board). Queries only `@inmolink/db/schema/crm`. Board order is
 * `(stage_rank, id)` within a stage (`crm/rank.ts`, as the pipeline's); the list is newest first on the stored
 * `created_ms`; the by-date view is `(next_follow_up_at, id)` ascending (a plain column checked to the millisecond).
 * Every row comparison is an index condition under RLS (the S10-02 rule). The seller's name is joined after the page.
 */

export const prospectColumns = {
  id: sellerProspects.id,
  agencyId: sellerProspects.agencyId,
  contactId: sellerProspects.contactId,
  title: sellerProspects.title,
  address: sellerProspects.address,
  area: sellerProspects.area,
  propertyTypeId: sellerProspects.propertyTypeId,
  locationId: sellerProspects.locationId,
  estimatedPriceCents: sellerProspects.estimatedPriceCents,
  currency: sellerProspects.currency,
  stage: sellerProspects.stage,
  stageRank: sellerProspects.stageRank,
  stageEnteredAt: sellerProspects.stageEnteredAt,
  nextFollowUpAt: sellerProspects.nextFollowUpAt,
  assignedUserId: sellerProspects.assignedUserId,
  confidentialNotes: sellerProspects.confidentialNotes,
  listingId: sellerProspects.listingId,
  convertedAt: sellerProspects.convertedAt,
  createdAt: sellerProspects.createdAt,
  createdMs: sellerProspects.createdMs,
  version: sellerProspects.version,
};

const withContact = {
  ...prospectColumns,
  contactFirstName: contacts.firstName,
  contactLastName: contacts.lastName,
};

export type ProspectBaseRow = {
  id: string;
  agencyId: string;
  contactId: string | null;
  title: string;
  address: string | null;
  area: string | null;
  propertyTypeId: string | null;
  locationId: string | null;
  estimatedPriceCents: number | null;
  currency: string | null;
  stage: string;
  stageRank: string;
  stageEnteredAt: Date;
  nextFollowUpAt: Date | null;
  assignedUserId: string | null;
  confidentialNotes: string | null;
  listingId: string | null;
  convertedAt: Date | null;
  createdAt: Date;
  createdMs: Date;
  version: number;
};
export type ProspectRow = ProspectBaseRow & { contactFirstName: string | null; contactLastName: string | null };

const live = (agencyId: string) => and(eq(sellerProspects.agencyId, agencyId), isNull(sellerProspects.deletedAt));
/** The seller's name: an open contact only (a closed one's name is never shown). */
const contactJoin = and(
  eq(contacts.agencyId, sellerProspects.agencyId),
  eq(contacts.id, sellerProspects.contactId),
  isNull(contacts.deletedAt),
);

export interface NewProspect {
  id: string;
  agencyId: string;
  contactId: string | null;
  title: string;
  address: string | null;
  area: string | null;
  propertyTypeId: string | null;
  locationId: string | null;
  estimatedPriceCents: number | null;
  currency: string | null;
  stageRank: string;
  nextFollowUpAt: Date | null;
  assignedUserId: string | null;
  confidentialNotes: string | null;
  createdBy: string | null;
  idempotencyHash: string | null;
  requestHash: string | null;
}

export async function insertProspect(tx: Tx, row: NewProspect): Promise<void> {
  await tx.insert(sellerProspects).values(row);
}

/** A live prospect of the agency with its seller's name. One query. */
export async function getProspect(tx: Tx, agencyId: string, id: string): Promise<ProspectRow | null> {
  const [row] = await tx
    .select(withContact)
    .from(sellerProspects)
    .leftJoin(contacts, contactJoin)
    .where(and(live(agencyId), eq(sellerProspects.id, id)));
  return row ?? null;
}

export type LockedProspect = ProspectRow & { contactClosed: boolean };

/**
 * A live prospect, locked (an edit, a drag, a conversion), with its seller's name and whether that contact is closed
 * (erased or merged away). One query; only the prospect's row is locked.
 */
export async function lockProspect(tx: Tx, agencyId: string, id: string): Promise<LockedProspect | null> {
  const [row] = await tx
    .select({
      ...prospectColumns,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactDeletedAt: contacts.deletedAt,
    })
    .from(sellerProspects)
    .leftJoin(
      contacts,
      and(eq(contacts.agencyId, sellerProspects.agencyId), eq(contacts.id, sellerProspects.contactId)),
    )
    .where(and(live(agencyId), eq(sellerProspects.id, id)))
    .for('update', { of: sellerProspects });
  if (!row) return null;
  const { contactDeletedAt, ...rest } = row;
  const contactClosed = rest.contactId !== null && contactDeletedAt !== null;
  return {
    ...rest,
    contactFirstName: contactClosed ? null : rest.contactFirstName,
    contactLastName: contactClosed ? null : rest.contactLastName,
    contactClosed,
  };
}

/**
 * The open contact a merged one now lives on: follows `merged_into_id` (flat after every merge, so one hop; a few for
 * safety) from `contactId`. Null when the chain ends on a closed contact that was not merged (erased). ≤ 4 queries.
 */
export async function openContactOf(tx: Tx, agencyId: string, contactId: string): Promise<string | null> {
  let id = contactId;
  for (let hop = 0; hop < 4; hop++) {
    const [row] = await tx
      .select({ mergedIntoId: contacts.mergedIntoId, deletedAt: contacts.deletedAt })
      .from(contacts)
      .where(and(eq(contacts.agencyId, agencyId), eq(contacts.id, id)));
    if (!row) return null;
    if (row.deletedAt === null) return id;
    if (!row.mergedIntoId) return null;
    id = row.mergedIntoId;
  }
  return null;
}

export async function prospectByIdempotency(
  tx: Tx,
  agencyId: string,
  hash: string,
  since: Date,
): Promise<{ id: string; requestHash: string | null } | null> {
  const [row] = await tx
    .select({ id: sellerProspects.id, requestHash: sellerProspects.requestHash })
    .from(sellerProspects)
    .where(
      and(
        eq(sellerProspects.agencyId, agencyId),
        eq(sellerProspects.idempotencyHash, hash),
        gt(sellerProspects.createdAt, since),
      ),
    );
  return row ?? null;
}

export interface ProspectPatch {
  title?: string;
  contactId?: string | null;
  address?: string | null;
  area?: string | null;
  propertyTypeId?: string | null;
  locationId?: string | null;
  estimatedPriceCents?: number | null;
  currency?: string | null;
  nextFollowUpAt?: Date | null;
  assignedUserId?: string | null;
  confidentialNotes?: string | null;
  stage?: string;
  stageRank?: string;
  stageEnteredAt?: Date;
  listingId?: string;
  convertedAt?: Date;
}

/** Updates under the caller's version; null when the version moved on (a concurrent edit). */
export async function updateProspect(
  tx: Tx,
  agencyId: string,
  id: string,
  version: number,
  patch: ProspectPatch,
): Promise<ProspectBaseRow | null> {
  const [row] = await tx
    .update(sellerProspects)
    .set({ ...patch, version: sql`${sellerProspects.version} + 1`, updatedAt: sql`now()` })
    .where(and(live(agencyId), eq(sellerProspects.id, id), eq(sellerProspects.version, version)))
    .returning(prospectColumns);
  return row ?? null;
}

export async function softDeleteProspect(tx: Tx, agencyId: string, id: string): Promise<boolean> {
  const rows = await tx
    .update(sellerProspects)
    .set({ deletedAt: sql`now()`, version: sql`${sellerProspects.version} + 1`, updatedAt: sql`now()` })
    .where(and(live(agencyId), eq(sellerProspects.id, id)))
    .returning({ id: sellerProspects.id });
  return rows.length > 0;
}

/** `assigned` as a condition (`undefined`: everyone's; `null`: unassigned). */
function assignedCondition(assigned: string | null | undefined): SQL | undefined {
  if (assigned === undefined) return undefined;
  return assigned === null ? isNull(sellerProspects.assignedUserId) : eq(sellerProspects.assignedUserId, assigned);
}

/**
 * The list, newest first: where agency_id = ? [and stage = ?] and deleted_at is null and (created_ms, id) < (?, ?)
 * order by created_ms desc, id desc — `seller_prospects_created_idx` / `…_stage_created_idx`. One query.
 */
export async function listProspects(
  tx: Tx,
  agencyId: string,
  filter: { stage?: string; assigned?: string | null },
  page: { limit: number; cursor?: KeysetCursor },
): Promise<ProspectRow[]> {
  return tx
    .select(withContact)
    .from(sellerProspects)
    .leftJoin(contacts, contactJoin)
    .where(
      and(
        live(agencyId),
        filter.stage ? eq(sellerProspects.stage, filter.stage) : undefined,
        assignedCondition(filter.assigned),
        rowAfter(sellerProspects.createdMs, sellerProspects.id, page.cursor),
      ),
    )
    .orderBy(...rowOrder(sellerProspects.createdMs, sellerProspects.id))
    .limit(page.limit + 1);
}

/**
 * The by-date view: follow-ups in `[from, to)`, soonest first, after the cursor — `seller_prospects_follow_up_idx`.
 * One query.
 */
export async function followUps(
  tx: Tx,
  agencyId: string,
  from: Date,
  to: Date,
  page: { limit: number; cursor?: KeysetCursor },
): Promise<ProspectRow[]> {
  return tx
    .select(withContact)
    .from(sellerProspects)
    .leftJoin(contacts, contactJoin)
    .where(
      and(
        live(agencyId),
        gte(sellerProspects.nextFollowUpAt, from),
        lt(sellerProspects.nextFollowUpAt, to),
        page.cursor
          ? sql`(${sellerProspects.nextFollowUpAt}, ${sellerProspects.id}) > (${page.cursor.at.toISOString()}::timestamptz, ${page.cursor.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(asc(sellerProspects.nextFollowUpAt), asc(sellerProspects.id))
    .limit(page.limit + 1);
}

const dateOf = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const dateOrNull = (v: unknown): Date | null => (v === null || v === undefined ? null : dateOf(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function fromRaw(r: Record<string, unknown>): ProspectRow {
  return {
    id: String(r.id),
    agencyId: String(r.agency_id),
    contactId: str(r.contact_id),
    title: String(r.title),
    address: str(r.address),
    area: str(r.area),
    propertyTypeId: str(r.property_type_id),
    locationId: str(r.location_id),
    estimatedPriceCents: r.estimated_price_cents === null ? null : Number(r.estimated_price_cents),
    currency: str(r.currency),
    stage: String(r.stage),
    stageRank: String(r.stage_rank),
    stageEnteredAt: dateOf(r.stage_entered_at),
    nextFollowUpAt: dateOrNull(r.next_follow_up_at),
    assignedUserId: str(r.assigned_user_id),
    confidentialNotes: str(r.confidential_notes),
    listingId: str(r.listing_id),
    convertedAt: dateOrNull(r.converted_at),
    createdAt: dateOf(r.created_at),
    createdMs: dateOf(r.created_ms),
    version: Number(r.version),
    contactFirstName: str(r.first_name),
    contactLastName: str(r.last_name),
  };
}

/**
 * Every stage's first `limit + 1` prospects in board order — one query: a lateral page per stage on
 * `seller_prospects_board_idx`, the seller joined after the page.
 */
export async function boardCards(
  tx: Tx,
  agencyId: string,
  stages: readonly string[],
  limit: number,
): Promise<ProspectRow[]> {
  const res = await tx.execute<Record<string, unknown>>(sql`
    select p.*, c.first_name, c.last_name
      from unnest(${sql`array[${sql.join(
        stages.map((s) => sql`${s}::text`),
        sql`, `,
      )}]`}) as s(stage)
     cross join lateral (
       select sp.id, sp.agency_id, sp.contact_id, sp.title, sp.address, sp.area, sp.property_type_id, sp.location_id,
              sp.estimated_price_cents, sp.currency, sp.stage, sp.stage_rank, sp.stage_entered_at, sp.next_follow_up_at,
              sp.assigned_user_id, sp.confidential_notes, sp.listing_id, sp.converted_at, sp.created_at, sp.created_ms,
              sp.version
         from ${sellerProspects} sp
        where sp.agency_id = ${agencyId} and sp.stage = s.stage and sp.deleted_at is null
        order by sp.stage_rank, sp.id
        limit ${limit + 1}
     ) p
      left join ${contacts} c on c.agency_id = p.agency_id and c.id = p.contact_id and c.deleted_at is null`);
  return res.rows.map(fromRaw);
}

/** Prospects per stage, each counted up to `cap` (a bounded probe on the board index). One query. */
export async function stageCounts(
  tx: Tx,
  agencyId: string,
  stages: readonly string[],
  cap: number,
): Promise<Map<string, number>> {
  const res = await tx.execute<{ stage: string; n: number }>(sql`
    select s.stage, (
      select count(*)::int from (
        select 1 from ${sellerProspects} sp
         where sp.agency_id = ${agencyId} and sp.stage = s.stage and sp.deleted_at is null
         limit ${cap}
      ) x
    ) as n
      from unnest(${sql`array[${sql.join(
        stages.map((s) => sql`${s}::text`),
        sql`, `,
      )}]`}) as s(stage)`);
  return new Map(res.rows.map((r) => [String(r.stage), Number(r.n)]));
}

export interface RankCursor {
  rank: string;
  id: string;
}

/** One column after `cursor`, board order (`(stage_rank, id) > (?, ?)`). One query. */
export async function columnCards(
  tx: Tx,
  agencyId: string,
  stage: string,
  page: { limit: number; cursor?: RankCursor },
): Promise<ProspectRow[]> {
  return tx
    .select(withContact)
    .from(sellerProspects)
    .leftJoin(contacts, contactJoin)
    .where(
      and(
        live(agencyId),
        eq(sellerProspects.stage, stage),
        page.cursor
          ? sql`(${sellerProspects.stageRank}, ${sellerProspects.id}) > (${page.cursor.rank}, ${page.cursor.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(asc(sellerProspects.stageRank), asc(sellerProspects.id))
    .limit(page.limit + 1);
}

/**
 * The keys around a drop right after `afterId` in a stage's column (`found` false when it is not there) and the next
 * card's rank, the moved prospect left out — or, with `afterId` null, the column's first rank. One query.
 */
export async function dropGap(
  tx: Tx,
  agencyId: string,
  stage: string,
  afterId: string | null,
  movedId: string,
): Promise<{ found: boolean; lower: string; upper: string | null }> {
  if (afterId === null) {
    const [row] = await tx
      .select({ rank: sellerProspects.stageRank })
      .from(sellerProspects)
      .where(and(live(agencyId), eq(sellerProspects.stage, stage), sql`${sellerProspects.id} <> ${movedId}::uuid`))
      .orderBy(asc(sellerProspects.stageRank), asc(sellerProspects.id))
      .limit(1);
    return { found: true, lower: '', upper: row?.rank ?? null };
  }
  const res = await tx.execute<{ lower: string | null; upper: string | null }>(sql`
    with a as (
      select stage_rank, id from ${sellerProspects}
       where agency_id = ${agencyId} and stage = ${stage} and id = ${afterId}::uuid and deleted_at is null
    )
    select (select stage_rank from a) as lower,
           (select p.stage_rank from ${sellerProspects} p, a
             where p.agency_id = ${agencyId} and p.stage = ${stage} and p.deleted_at is null
               and p.id <> ${movedId}::uuid and (p.stage_rank, p.id) > (a.stage_rank, a.id)
             order by p.stage_rank, p.id limit 1) as upper`);
  const row = res.rows[0];
  if (!row?.lower) return { found: false, lower: '', upper: null };
  return { found: true, lower: row.lower, upper: row.upper };
}

/** Rows a rebalance re-ranks at most (a larger column refuses the drop). */
export const REBALANCE_MAX = 10_000;

/**
 * Re-ranks a column in its board order with evenly spaced keys (`keyOf`), the moved prospect left out. Two statements.
 * Versions are not bumped: the order is not a prospect's content.
 */
export async function rebalanceColumn(
  tx: Tx,
  agencyId: string,
  stage: string,
  movedId: string,
  keyOf: (index: number, total: number) => string,
): Promise<boolean> {
  const ids = await tx
    .select({ id: sellerProspects.id })
    .from(sellerProspects)
    .where(and(live(agencyId), eq(sellerProspects.stage, stage), sql`${sellerProspects.id} <> ${movedId}::uuid`))
    .orderBy(asc(sellerProspects.stageRank), asc(sellerProspects.id))
    .limit(REBALANCE_MAX + 1);
  if (ids.length > REBALANCE_MAX) return false;
  if (ids.length === 0) return true;
  const keys = ids.map((_, i) => keyOf(i, ids.length));
  await tx.execute(sql`
    update ${sellerProspects} p set stage_rank = v.rank
      from unnest(${sql`array[${sql.join(
        ids.map((r) => sql`${r.id}::uuid`),
        sql`, `,
      )}]`}, ${sql`array[${sql.join(
        keys.map((k) => sql`${k}::text`),
        sql`, `,
      )}]`}) as v(id, rank)
     where p.agency_id = ${agencyId} and p.id = v.id`);
  return true;
}

/** A purged listing leaves its prospect (which stays listed, without the listing). `seller_prospects_listing_uq`. */
export async function clearListing(tx: Tx, agencyId: string, listingId: string): Promise<number> {
  const rows = await tx
    .update(sellerProspects)
    .set({ listingId: null, version: sql`${sellerProspects.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(sellerProspects.agencyId, agencyId), eq(sellerProspects.listingId, listingId)))
    .returning({ id: sellerProspects.id });
  return rows.length;
}
