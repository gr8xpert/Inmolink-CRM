import type { Tx } from '@inmolink/db';
import { activities, contacts, leads } from '@inmolink/db/schema/crm';
import { and, eq, gt, gte, isNull, lte, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';
import type { KeysetCursor } from '../../pagination';
import { rowAfter, rowOrder } from './keyset';

/**
 * Activity timeline queries (S10-04). `activities` is partitioned by month on `occurred_at`; every list is a keyset on
 * `(occurred_at, id)` — the partition key itself, stored to the millisecond — so the cursor is an index condition under
 * RLS and `occurred_at <= cursor` also prunes the months after it.
 */

export const activityColumns = {
  id: activities.id,
  type: activities.type,
  occurredAt: activities.occurredAt,
  contactId: activities.contactId,
  leadId: activities.leadId,
  listingId: activities.listingId,
  actorUserId: activities.actorUserId,
  body: activities.body,
  data: activities.data,
};
export type ActivityRow = {
  id: string;
  type: string;
  occurredAt: Date;
  contactId: string | null;
  leadId: string | null;
  listingId: string | null;
  actorUserId: string | null;
  body: string | null;
  data: unknown;
};

export interface NewActivity {
  id: string;
  agencyId: string;
  occurredAt: Date;
  type: string;
  contactId?: string | null;
  leadId?: string | null;
  listingId?: string | null;
  actorUserId?: string | null;
  eventId?: string | null;
  idempotencyHash?: string | null;
  requestHash?: string | null;
  body?: string | null;
  data?: Record<string, unknown>;
}

/**
 * Appends activities in one statement. Rows from an outbox event (`eventId`) that were already recorded (a redelivery)
 * are skipped (`activities_event_uq`); returns the rows written.
 */
export async function insertActivities(tx: Tx, rows: readonly NewActivity[]): Promise<ActivityRow[]> {
  if (rows.length === 0) return [];
  return tx
    .insert(activities)
    .values(
      rows.map((r) => ({
        id: r.id,
        agencyId: r.agencyId,
        // a JS Date is to the millisecond already (the column's check)
        occurredAt: r.occurredAt,
        type: r.type,
        contactId: r.contactId ?? null,
        leadId: r.leadId ?? null,
        listingId: r.listingId ?? null,
        actorUserId: r.actorUserId ?? null,
        eventId: r.eventId ?? null,
        idempotencyHash: r.idempotencyHash ?? null,
        requestHash: r.requestHash ?? null,
        body: r.body ?? null,
        data: r.data ?? {},
      })),
    )
    .onConflictDoNothing()
    .returning(activityColumns);
}

export type ActivitySubjectColumn = 'contact' | 'lead' | 'listing';
const subjectColumn = {
  contact: activities.contactId,
  lead: activities.leadId,
  listing: activities.listingId,
} as const;

export interface ActivityFilter {
  subject?: { column: ActivitySubjectColumn; id: string };
  types?: readonly string[];
}

/**
 * One page of the timeline, newest first: where agency_id = ? [and <subject>_id = ?] [and type …]
 * and (occurred_at, id) < (?, ?) order by occurred_at desc, id desc — `activities_<subject>_idx` (or
 * `activities_agency_idx`) on each partition, merged. The agency feed filtered by type (S11-F6) is index-driven:
 * one type is `type = ?` on `activities_agency_type_idx`; several types read one keyset page per type there and
 * merge them (`union all`, at most `typesPerFilter` branches), never `type = any(?)` as a Filter over the whole feed.
 * A subject's own timeline is bounded, so its type filter stays a Filter on the subject's index.
 */
export async function listActivities(
  tx: Tx,
  agencyId: string,
  filter: ActivityFilter,
  page: { limit: number; cursor?: KeysetCursor },
): Promise<ActivityRow[]> {
  return await activitiesPageQuery(tx, agencyId, filter, page);
}

/** The statement of `listActivities`, not yet run (the EXPLAIN tests run the repo's own query). */
export function activitiesPageQuery(
  tx: Tx,
  agencyId: string,
  filter: ActivityFilter,
  page: { limit: number; cursor?: KeysetCursor },
): PromiseLike<ActivityRow[]> & SQLWrapper {
  const types = filter.types ? [...new Set(filter.types)] : [];
  const branch = (typeConds: SQL[]) => {
    const conds: (SQL | undefined)[] = [eq(activities.agencyId, agencyId), ...typeConds];
    if (filter.subject) conds.push(eq(subjectColumn[filter.subject.column], filter.subject.id));
    if (page.cursor) {
      // the row comparison is the index condition; the plain bound prunes the partitions after the cursor's month
      conds.push(
        lte(activities.occurredAt, page.cursor.at),
        rowAfter(activities.occurredAt, activities.id, page.cursor),
      );
    }
    return tx
      .select(activityColumns)
      .from(activities)
      .where(and(...conds))
      .orderBy(...rowOrder(activities.occurredAt, activities.id))
      .limit(page.limit + 1);
  };
  if (types.length === 0) return branch([]);
  if (types.length === 1 || filter.subject) {
    return branch(
      types.length === 1
        ? [eq(activities.type, types[0] as string)]
        : [sql`${activities.type} = any(${sql.param(types)}::text[])`],
    );
  }
  // here `types.length >= 2` (0 and 1 returned above), so `first` and `second` exist
  const [first, second, ...rest] = types.map((t) => branch([eq(activities.type, t)]));
  return unionAll(first as NonNullable<typeof first>, second as NonNullable<typeof second>, ...rest)
    .orderBy(sql`occurred_at desc`, sql`id desc`)
    .limit(page.limit + 1);
}

/**
 * POST replay: the activity this member's key wrote within the window (`activities_idempotency_idx`). `occurredSince`
 * bounds the months read: a logged activity is never older than the backdating limit, so older partitions are pruned.
 */
export async function activityByIdempotency(
  tx: Tx,
  agencyId: string,
  hash: string,
  since: Date,
  occurredSince: Date,
): Promise<{ row: ActivityRow; requestHash: string | null } | null> {
  const [row] = await tx
    .select({ ...activityColumns, requestHash: activities.requestHash })
    .from(activities)
    .where(
      and(
        eq(activities.agencyId, agencyId),
        eq(activities.idempotencyHash, hash),
        gt(activities.createdAt, since),
        gte(activities.occurredAt, occurredSince),
      ),
    )
    .limit(1);
  if (!row) return null;
  const { requestHash, ...rest } = row;
  return { row: rest, requestHash };
}

/**
 * What a lead's activities name besides the lead: its contact and, when the target is one of the agency's own listings,
 * that listing (a network listing's timeline is its owner's, who never sees the client).
 */
export async function leadSubjects(
  tx: Tx,
  agencyId: string,
  leadId: string,
): Promise<{ contactId: string; listingId: string | null } | null> {
  const [row] = await tx
    .select({
      contactId: leads.contactId,
      targetKind: leads.targetKind,
      targetId: leads.targetId,
      ownerAgencyId: leads.ownerAgencyId,
    })
    .from(leads)
    .where(and(eq(leads.agencyId, agencyId), eq(leads.id, leadId)));
  if (!row) return null;
  return {
    contactId: row.contactId,
    listingId: row.targetKind === 'LISTING' && !row.ownerAgencyId ? row.targetId : null,
  };
}

/** Whether the contact is one of the agency's open contacts (not merged or deleted). */
export async function contactOpen(tx: Tx, agencyId: string, contactId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.agencyId, agencyId), eq(contacts.id, contactId), isNull(contacts.deletedAt)));
  return row !== undefined;
}

/**
 * A purged listing leaves the timelines (S10-04 review): up to `limit` of its activities per call — those that name
 * only the listing are deleted, the others (a lead's, a contact's) keep their row without the listing. One statement
 * (`activities_listing_idx`); returns the rows handled, so the caller repeats until fewer than `limit`.
 */
export async function forgetListing(tx: Tx, agencyId: string, listingId: string, limit: number): Promise<number> {
  const res = await tx.execute(sql`
    with batch as (
      select id, occurred_at, (contact_id is null and lead_id is null) as only_listing from ${activities}
      where agency_id = ${agencyId} and listing_id = ${listingId} limit ${limit}),
    d as (delete from ${activities} a using batch b
      where a.agency_id = ${agencyId} and a.id = b.id and a.occurred_at = b.occurred_at and b.only_listing returning 1),
    u as (update ${activities} a set listing_id = null from batch b
      where a.agency_id = ${agencyId} and a.id = b.id and a.occurred_at = b.occurred_at and not b.only_listing returning 1)
    select (select count(*) from d)::int + (select count(*) from u)::int as n`);
  return Number((res.rows[0] as { n: number } | undefined)?.n ?? 0);
}
