import type { Tx } from '@inmolink/db';
import { networkPostAuthors, networkPosts, networkSubscriptions } from '@inmolink/db/schema/network';
import { and, asc, eq, gt, type SQL, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfterRaw, keysetOrderRaw, keysetStamp } from '../../pagination';

/**
 * network queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor on raw columns
 * (`keysetAfterRaw`: an index condition under RLS). Queries only `@inmolink/db/schema/network`. Request paths read
 * posts under the caller's RLS (its own, and the open posts of the network); workers read as `app_system`.
 */

export interface PostRow {
  id: string;
  agencyId: string;
  kind: string;
  status: string;
  title: string;
  body: string;
  transactionType: string | null;
  propertyTypeIds: string[] | null;
  locationIds: string[] | null;
  locationScopeIds: string[] | null;
  featureIds: string[] | null;
  priceMinCents: number | null;
  priceMaxCents: number | null;
  currency: string;
  bedsMin: number | null;
  bathsMin: number | null;
  areaMinM2: number | null;
  areaMaxM2: number | null;
  expiresAt: Date;
  createdAt: Date;
}

const postColumns = {
  id: networkPosts.id,
  agencyId: networkPosts.agencyId,
  kind: networkPosts.kind,
  status: networkPosts.status,
  title: networkPosts.title,
  body: networkPosts.body,
  transactionType: networkPosts.transactionType,
  propertyTypeIds: networkPosts.propertyTypeIds,
  locationIds: networkPosts.locationIds,
  locationScopeIds: networkPosts.locationScopeIds,
  featureIds: networkPosts.featureIds,
  priceMinCents: networkPosts.priceMinCents,
  priceMaxCents: networkPosts.priceMaxCents,
  currency: networkPosts.currency,
  bedsMin: networkPosts.bedsMin,
  bathsMin: networkPosts.bathsMin,
  areaMinM2: networkPosts.areaMinM2,
  areaMaxM2: networkPosts.areaMaxM2,
  expiresAt: networkPosts.expiresAt,
  createdAt: networkPosts.createdAt,
};

export type NewPost = Omit<PostRow, 'status' | 'createdAt'>;

/** A post of the caller's agency (open; the database's clock stamps it). */
export async function insertPost(tx: Tx, p: NewPost): Promise<PostRow> {
  const [row] = await tx.insert(networkPosts).values(p).returning(postColumns);
  return row as PostRow;
}

/** The post's private side: its author and Idempotency-Key (`network_post_authors_idempotency_uq`). */
export async function insertAuthor(
  tx: Tx,
  a: {
    agencyId: string;
    postId: string;
    createdByUserId: string;
    idempotencyHash: string | null;
    requestHash: string | null;
  },
): Promise<void> {
  await tx.insert(networkPostAuthors).values(a);
}

/** The agency's post created with this key since `since` (POST replay), with the stored body fingerprint. */
export async function postByIdempotency(
  tx: Tx,
  agencyId: string,
  hash: string,
  since: Date,
): Promise<{ row: PostRow; requestHash: string | null } | null> {
  const [row] = await tx
    .select({ ...postColumns, requestHash: networkPostAuthors.requestHash })
    .from(networkPostAuthors)
    .innerJoin(networkPosts, eq(networkPosts.id, networkPostAuthors.postId))
    .where(
      and(
        eq(networkPostAuthors.agencyId, agencyId),
        eq(networkPostAuthors.idempotencyHash, hash),
        gt(networkPostAuthors.createdAt, since),
      ),
    );
  if (!row) return null;
  const { requestHash, ...rest } = row;
  return { row: rest, requestHash };
}

/** A post as the caller's RLS shows it (its own agency's, or an open one of the network), or null. */
export async function getPost(tx: Tx, id: string): Promise<PostRow | null> {
  const [row] = await tx.select(postColumns).from(networkPosts).where(eq(networkPosts.id, id));
  return row ?? null;
}

/** Who posted the agency's post (its own agency only). */
export async function authorOf(tx: Tx, agencyId: string, postId: string): Promise<string | null> {
  const [row] = await tx
    .select({ userId: networkPostAuthors.createdByUserId })
    .from(networkPostAuthors)
    .where(and(eq(networkPostAuthors.agencyId, agencyId), eq(networkPostAuthors.postId, postId)));
  return row?.userId ?? null;
}

/** The agency's open post closed (null: none, or closed already). */
export async function closePost(tx: Tx, agencyId: string, id: string): Promise<PostRow | null> {
  const [row] = await tx
    .update(networkPosts)
    .set({ status: 'CLOSED', closedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(networkPosts.agencyId, agencyId), eq(networkPosts.id, id), eq(networkPosts.status, 'OPEN')))
    .returning(postColumns);
  return row ?? null;
}

/**
 * The board, newest first: open, unexpired posts the caller's RLS shows (`network_posts_open_idx`, or
 * `network_posts_open_kind_idx` with a kind).
 */
export function boardQuery(tx: Tx, q: { kind?: string; limit: number; cursor?: KeysetCursor }) {
  return tx
    .select({ ...postColumns, atUs: keysetStamp(networkPosts.createdAt) })
    .from(networkPosts)
    .where(
      and(
        eq(networkPosts.status, 'OPEN'),
        sql`${networkPosts.expiresAt} > now()`,
        q.kind ? eq(networkPosts.kind, q.kind) : undefined,
        keysetAfterRaw(networkPosts.createdAt, networkPosts.id, q.cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrderRaw(networkPosts.createdAt, networkPosts.id, 'desc'))
    .limit(q.limit + 1);
}

export async function board(
  tx: Tx,
  q: { kind?: string; limit: number; cursor?: KeysetCursor },
): Promise<(PostRow & { atUs: string })[]> {
  return boardQuery(tx, q);
}

/** The agency's own posts in every state, newest first (`network_posts_agency_idx`). */
export async function ownPosts(
  tx: Tx,
  agencyId: string,
  q: { kind?: string; limit: number; cursor?: KeysetCursor },
): Promise<(PostRow & { atUs: string })[]> {
  return tx
    .select({ ...postColumns, atUs: keysetStamp(networkPosts.createdAt) })
    .from(networkPosts)
    .where(
      and(
        eq(networkPosts.agencyId, agencyId),
        q.kind ? eq(networkPosts.kind, q.kind) : undefined,
        keysetAfterRaw(networkPosts.createdAt, networkPosts.id, q.cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrderRaw(networkPosts.createdAt, networkPosts.id, 'desc'))
    .limit(q.limit + 1);
}

/* ------------------------------------------------------------------ subscriptions */

export interface SubscriptionRow {
  id: string;
  name: string;
  kinds: string[] | null;
  transactionType: string | null;
  propertyTypeIds: string[] | null;
  locationIds: string[] | null;
  priceMinCents: number | null;
  priceMaxCents: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const subscriptionColumns = {
  id: networkSubscriptions.id,
  name: networkSubscriptions.name,
  kinds: networkSubscriptions.kinds,
  transactionType: networkSubscriptions.transactionType,
  propertyTypeIds: networkSubscriptions.propertyTypeIds,
  locationIds: networkSubscriptions.locationIds,
  priceMinCents: networkSubscriptions.priceMinCents,
  priceMaxCents: networkSubscriptions.priceMaxCents,
  createdAt: networkSubscriptions.createdAt,
  updatedAt: networkSubscriptions.updatedAt,
};

export type SubscriptionFields = Omit<SubscriptionRow, 'id' | 'createdAt' | 'updatedAt'>;

/** The member's subscriptions, oldest first (`network_subscriptions_user_idx`), at most `max`. */
export async function subscriptionsOf(
  tx: Tx,
  agencyId: string,
  userId: string,
  max: number,
): Promise<SubscriptionRow[]> {
  return tx
    .select(subscriptionColumns)
    .from(networkSubscriptions)
    .where(and(eq(networkSubscriptions.agencyId, agencyId), eq(networkSubscriptions.userId, userId)))
    .orderBy(asc(networkSubscriptions.createdAt), asc(networkSubscriptions.id))
    .limit(max);
}

/**
 * A subscription of the member, unless they have `max` already (one statement: the count and the insert). Null at the
 * limit.
 */
export async function insertSubscription(
  tx: Tx,
  s: SubscriptionFields & { agencyId: string; id: string; userId: string; max: number },
): Promise<SubscriptionRow | null> {
  const result = await tx.execute<{ id: string }>(sql`
    insert into ${networkSubscriptions}
      (agency_id, id, user_id, name, kinds, transaction_type, property_type_ids, location_ids, price_min_cents,
       price_max_cents)
    select ${s.agencyId}::uuid, ${s.id}::uuid, ${s.userId}::uuid, ${s.name}, ${pgArray(s.kinds, 'text')},
           ${s.transactionType}, ${pgArray(s.propertyTypeIds, 'uuid')}, ${pgArray(s.locationIds, 'uuid')},
           ${s.priceMinCents}::bigint, ${s.priceMaxCents}::bigint
     where (select count(*) from ${networkSubscriptions} n
             where n.agency_id = ${s.agencyId} and n.user_id = ${s.userId}) < ${s.max}
    returning id`);
  if (result.rows.length === 0) return null;
  return subscriptionOf(tx, s.agencyId, s.userId, s.id);
}

/** A typed array parameter (null stays null). */
function pgArray(values: readonly string[] | null, type: 'text' | 'uuid') {
  if (values === null) return sql`null`;
  const items = sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
  return type === 'uuid' ? sql`array[${items}]::uuid[]` : sql`array[${items}]::text[]`;
}

export async function subscriptionOf(
  tx: Tx,
  agencyId: string,
  userId: string,
  id: string,
): Promise<SubscriptionRow | null> {
  const [row] = await tx
    .select(subscriptionColumns)
    .from(networkSubscriptions)
    .where(
      and(
        eq(networkSubscriptions.agencyId, agencyId),
        eq(networkSubscriptions.id, id),
        eq(networkSubscriptions.userId, userId),
      ),
    );
  return row ?? null;
}

/** The member's subscription replaced (null: not theirs). */
export async function updateSubscription(
  tx: Tx,
  agencyId: string,
  userId: string,
  id: string,
  s: SubscriptionFields,
): Promise<SubscriptionRow | null> {
  const [row] = await tx
    .update(networkSubscriptions)
    .set({ ...s, updatedAt: sql`now()` })
    .where(
      and(
        eq(networkSubscriptions.agencyId, agencyId),
        eq(networkSubscriptions.id, id),
        eq(networkSubscriptions.userId, userId),
      ),
    )
    .returning(subscriptionColumns);
  return row ?? null;
}

export async function deleteSubscription(tx: Tx, agencyId: string, userId: string, id: string): Promise<boolean> {
  const rows = await tx
    .delete(networkSubscriptions)
    .where(
      and(
        eq(networkSubscriptions.agencyId, agencyId),
        eq(networkSubscriptions.id, id),
        eq(networkSubscriptions.userId, userId),
      ),
    )
    .returning({ id: networkSubscriptions.id });
  return rows.length > 0;
}

/* ------------------------------------------------------------------ worker side (app_system) */

/** A post by id, whatever its agency (the worker's). */
export async function postById(tx: Tx, id: string): Promise<PostRow | null> {
  const [row] = await tx.select(postColumns).from(networkPosts).where(eq(networkPosts.id, id));
  return row ?? null;
}

export interface SubscriberRow {
  agencyId: string;
  userId: string;
}

/**
 * What a subscription must satisfy to match the post (every filter it sets holds; a filter the post leaves empty does
 * not match): the post's kind among its kinds, the same transaction type, a property type in common, a location of
 * the subscription among the post's locations or their ancestors, overlapping price ranges.
 */
function subscriptionMatches(post: PostRow): SQL {
  const s = networkSubscriptions;
  const types = post.propertyTypeIds ?? [];
  const places = post.locationScopeIds ?? [];
  return and(
    sql`${s.agencyId} <> ${post.agencyId}`,
    sql`(${s.kinds} is null or ${post.kind} = any(${s.kinds}))`,
    post.transactionType
      ? sql`(${s.transactionType} is null or ${s.transactionType} = ${post.transactionType})`
      : sql`${s.transactionType} is null`,
    types.length > 0
      ? sql`(${s.propertyTypeIds} is null or ${s.propertyTypeIds} && ${pgArray(types, 'uuid')})`
      : sql`${s.propertyTypeIds} is null`,
    places.length > 0
      ? sql`(${s.locationIds} is null or ${s.locationIds} && ${pgArray(places, 'uuid')})`
      : sql`${s.locationIds} is null`,
    // a post without a price matches only subscriptions without one
    post.priceMinCents === null && post.priceMaxCents === null
      ? sql`${s.priceMinCents} is null and ${s.priceMaxCents} is null`
      : undefined,
    post.priceMinCents !== null
      ? sql`(${s.priceMaxCents} is null or ${s.priceMaxCents} >= ${post.priceMinCents}::bigint)`
      : undefined,
    post.priceMaxCents !== null
      ? sql`(${s.priceMinCents} is null or ${s.priceMinCents} <= ${post.priceMaxCents}::bigint)`
      : undefined,
  ) as SQL;
}

/**
 * The members subscribed to the post in the next `agencies` agencies with a matching subscription, after `afterAgency`
 * in agency order — one statement: the agencies by a walk of `network_subscriptions_pk`, then their matching
 * subscriptions' distinct members (by the same index), at most `maxRows`.
 */
export function matchingSubscribersQuery(post: PostRow, afterAgency: string | null, agencies: number, maxRows: number) {
  const s = networkSubscriptions;
  const match = subscriptionMatches(post);
  const after = afterAgency ? sql`and ${s.agencyId} > ${afterAgency}::uuid` : sql``;
  return sql`
    with page as (
      select distinct ${s.agencyId} as agency_id from ${s}
       where ${match} ${after}
       order by 1
       limit ${agencies}
    )
    select distinct ${s.agencyId} as "agencyId", ${s.userId} as "userId" from ${s}
     where ${s.agencyId} in (select agency_id from page) and ${match}
     order by 1, 2
     limit ${maxRows}`;
}

export async function matchingSubscribers(
  tx: Tx,
  post: PostRow,
  afterAgency: string | null,
  agencies: number,
  maxRows: number,
): Promise<SubscriberRow[]> {
  const result = await tx.execute<{ agencyId: string; userId: string }>(
    matchingSubscribersQuery(post, afterAgency, agencies, maxRows),
  );
  return result.rows;
}

/**
 * The expiry sweep: up to `limit` OPEN posts past their expiry closed, the longest expired first
 * (`network_posts_expiry_idx`; `skip locked`: a concurrent close or sweep is left alone). Their ids and agencies.
 */
export async function closeExpiredPosts(tx: Tx, limit: number): Promise<{ id: string; agencyId: string }[]> {
  const result = await tx.execute<{ id: string; agencyId: string }>(sql`
    update ${networkPosts} p set status = 'CLOSED', closed_at = now(), updated_at = now()
     where p.id in (
       select id from ${networkPosts}
        where status = 'OPEN' and expires_at <= now()
        order by expires_at, id
        limit ${limit}
        for update skip locked)
    returning p.id, p.agency_id as "agencyId"`);
  return result.rows.map((r) => ({ id: r.id, agencyId: r.agencyId }));
}
