/**
 * properties queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/properties` — other modules' tables fail `pnpm check:boundaries`.
 * Runs as `app_user` under `withTenant`: RLS shows the agency's own listings plus the network's shared ones.
 */
import type { Tx } from '@inmolink/db';
import {
  listingBulkActions,
  listingViews,
  properties,
  propertyFeatures,
  propertyPriceHistories,
  propertyPrivates,
  propertyStatusHistories,
  propertyTags,
  propertyTranslations,
} from '@inmolink/db/schema/properties';
import { and, asc, eq, gte, inArray, isNull, lt, lte, notInArray, type SQL, sql } from 'drizzle-orm';
import { keysetAfter, keysetOrder } from '../../pagination';

export type ListingRow = typeof properties.$inferSelect;
export type ListingInsert = typeof properties.$inferInsert;
export type PrivatesRow = typeof propertyPrivates.$inferSelect;
export type PrivatesPatch = Partial<Omit<typeof propertyPrivates.$inferInsert, 'propertyId' | 'agencyId'>>;
export type ListingStatus = ListingRow['status'];

export async function insertListing(tx: Tx, row: ListingInsert): Promise<ListingRow> {
  const [created] = await tx.insert(properties).values(row).returning();
  return created as ListingRow;
}

export async function insertPrivates(tx: Tx, row: typeof propertyPrivates.$inferInsert): Promise<PrivatesRow> {
  const [created] = await tx.insert(propertyPrivates).values(row).returning();
  return created as PrivatesRow;
}

/** A listing visible to the caller (own or shared with it, RLS), deleted ones included; null if none. */
export async function getListing(tx: Tx, id: string): Promise<ListingRow | null> {
  const [row] = await tx.select().from(properties).where(eq(properties.id, id));
  return row ?? null;
}

/** The caller's own listing, row-locked for a change (other agencies' rows are never locked or written). */
export async function getOwnForUpdate(tx: Tx, agencyId: string, id: string): Promise<ListingRow | null> {
  const [row] = await tx
    .select()
    .from(properties)
    .where(and(eq(properties.id, id), eq(properties.agencyId, agencyId)))
    .for('update');
  return row ?? null;
}

export async function getPrivates(tx: Tx, propertyId: string): Promise<PrivatesRow | null> {
  const [row] = await tx.select().from(propertyPrivates).where(eq(propertyPrivates.propertyId, propertyId));
  return row ?? null;
}

/** Optimistic update: null when `version` is stale. Bumps `version` and `updated_at`. */
export async function updateWithVersion(
  tx: Tx,
  id: string,
  version: number,
  patch: Partial<ListingInsert>,
): Promise<ListingRow | null> {
  const [row] = await tx
    .update(properties)
    .set({ ...patch, version: sql`${properties.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(properties.id, id), eq(properties.version, version)))
    .returning();
  return row ?? null;
}

export async function updatePrivates(tx: Tx, propertyId: string, patch: PrivatesPatch): Promise<PrivatesRow | null> {
  const [row] = await tx
    .update(propertyPrivates)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(propertyPrivates.propertyId, propertyId))
    .returning();
  return row ?? null;
}

export async function insertPriceHistory(
  tx: Tx,
  row: {
    id: string;
    propertyId: string;
    agencyId: string;
    previousPriceCents: number | null;
    priceCents: number | null;
    currency: string;
    changedByUserId: string | null;
  },
): Promise<void> {
  await tx.insert(propertyPriceHistories).values(row);
}

export async function insertStatusHistory(
  tx: Tx,
  row: {
    id: string;
    propertyId: string;
    agencyId: string;
    fromStatus: ListingStatus | null;
    toStatus: ListingStatus;
    changedByUserId: string | null;
  },
): Promise<void> {
  await tx.insert(propertyStatusHistories).values(row);
}

const summaryColumns = {
  id: properties.id,
  ref: properties.ref,
  ownerUserId: properties.ownerUserId,
  status: properties.status,
  visibility: properties.visibility,
  shareScope: properties.shareScope,
  transactionType: properties.transactionType,
  priceCents: properties.priceCents,
  currency: properties.currency,
  bedrooms: properties.bedrooms,
  bathrooms: properties.bathrooms,
  builtM2: properties.builtM2,
  propertyTypeId: properties.propertyTypeId,
  locationId: properties.locationId,
  createdAt: properties.createdAt,
  updatedAt: properties.updatedAt,
  deletedAt: properties.deletedAt,
};
export type ListingSummaryRow = { [K in keyof typeof summaryColumns]: ListingRow[K] };

/** The list filters (S3-07), all optional; each narrows the agency's own listings. */
export interface ListFilter {
  status?: ListingStatus;
  visibility?: ListingRow['visibility'];
  transactionType?: ListingRow['transactionType'];
  propertyTypeId?: string;
  locationId?: string;
  ownerUserId?: string;
  priceMin?: number;
  priceMax?: number;
  bedroomsMin?: number;
  tag?: string;
  /** Upper-case start of the reference. */
  refPrefix?: string;
}

export type ListSort = 'newest' | 'oldest' | 'updated' | 'price_asc' | 'price_desc';
/** Where a page starts: the last row's sort key — a time for the time sorts, the price (or null) for price sorts. */
export type ListCursor = { kind: 'time'; at: Date; id: string } | { kind: 'price'; price: number | null; id: string };

/** The filters as `WHERE` parts. uuid and number conditions only: the agency index does the work (S2-F1). */
function filterWhere(agencyId: string, f: ListFilter): (SQL | undefined)[] {
  return [
    eq(properties.agencyId, agencyId),
    f.status ? eq(properties.status, f.status) : undefined,
    f.visibility ? eq(properties.visibility, f.visibility) : undefined,
    f.transactionType ? eq(properties.transactionType, f.transactionType) : undefined,
    f.propertyTypeId ? eq(properties.propertyTypeId, f.propertyTypeId) : undefined,
    f.locationId ? eq(properties.locationId, f.locationId) : undefined,
    f.ownerUserId ? eq(properties.ownerUserId, f.ownerUserId) : undefined,
    f.priceMin !== undefined ? gte(properties.priceCents, f.priceMin) : undefined,
    f.priceMax !== undefined ? lte(properties.priceCents, f.priceMax) : undefined,
    f.bedroomsMin !== undefined ? gte(properties.bedrooms, f.bedroomsMin) : undefined,
    f.refPrefix ? sql`upper(${properties.ref}) like ${`${f.refPrefix}%`}` : undefined,
    f.tag
      ? sql`exists (select 1 from ${propertyTags} t where t.property_id = ${properties.id} and t.tag = ${f.tag})`
      : undefined,
  ];
}

/** Price order, listings without a price last in both directions; keyset on `(price_cents, id)`. */
function priceAfter(dir: 'asc' | 'desc', cursor: ListCursor | undefined): SQL | undefined {
  if (cursor?.kind !== 'price') return undefined;
  const after = dir === 'asc' ? sql`>` : sql`<`;
  const id = properties.id;
  const price = properties.priceCents;
  if (cursor.price === null) return sql`(${price} is null and ${id} ${after} ${cursor.id})`;
  return sql`(${price} ${after} ${cursor.price} or (${price} = ${cursor.price} and ${id} ${after} ${cursor.id})
    or ${price} is null)`;
}

function orderFor(sort: ListSort, cursor: ListCursor | undefined): { after: SQL | undefined; order: SQL[] } {
  const time = cursor?.kind === 'time' ? { at: cursor.at, id: cursor.id } : undefined;
  switch (sort) {
    case 'newest':
      return {
        after: keysetAfter(properties.createdAt, properties.id, time, 'desc'),
        order: keysetOrder(properties.createdAt, properties.id, 'desc'),
      };
    case 'oldest':
      return {
        after: keysetAfter(properties.createdAt, properties.id, time, 'asc'),
        order: keysetOrder(properties.createdAt, properties.id, 'asc'),
      };
    case 'updated':
      return {
        after: keysetAfter(properties.updatedAt, properties.id, time, 'desc'),
        order: keysetOrder(properties.updatedAt, properties.id, 'desc'),
      };
    case 'price_asc':
      return {
        after: priceAfter('asc', cursor),
        order: [sql`${properties.priceCents} asc nulls last`, asc(properties.id)],
      };
    case 'price_desc':
      return {
        after: priceAfter('desc', cursor),
        // matches `properties_agency_price_desc_idx` exactly (ids are never null; the planner still wants it said)
        order: [sql`${properties.priceCents} desc nulls last`, sql`${properties.id} desc nulls last`],
      };
  }
}

/**
 * The agency's own listings, filtered and sorted (S3-07), keyset-paged: the time sorts walk
 * `properties_agency_created_idx` / `properties_agency_updated_idx`, the price sorts
 * `properties_agency_price_idx`. `deletedSince`: the listings deleted since then (the restorable ones),
 * newest first, instead of the live ones.
 */
export async function listOwn(
  tx: Tx,
  agencyId: string,
  q: { limit: number; sort: ListSort; cursor?: ListCursor; filter: ListFilter; deletedSince?: Date },
): Promise<ListingSummaryRow[]> {
  const sort = q.deletedSince ? 'newest' : q.sort;
  const { after, order } = orderFor(sort, q.cursor);
  return tx
    .select(summaryColumns)
    .from(properties)
    .where(
      and(
        ...filterWhere(agencyId, q.filter),
        q.deletedSince ? gte(properties.deletedAt, q.deletedSince) : isNull(properties.deletedAt),
        after,
      ),
    )
    .orderBy(...order)
    .limit(q.limit + 1);
}

/** The ids of the agency's live listings matching `filter`, newest first, at most `limit` (bulk "all matching"). */
export async function idsMatching(tx: Tx, agencyId: string, filter: ListFilter, limit: number): Promise<string[]> {
  const rows = await tx
    .select({ id: properties.id })
    .from(properties)
    .where(and(...filterWhere(agencyId, filter), isNull(properties.deletedAt)))
    .orderBy(...keysetOrder(properties.createdAt, properties.id, 'desc'))
    .limit(limit);
  return rows.map((r) => r.id);
}

/** The tags of these listings, sorted, by listing (one query for a page). */
export async function tagsOf(tx: Tx, propertyIds: string[]): Promise<Map<string, string[]>> {
  const byId = new Map<string, string[]>();
  if (propertyIds.length === 0) return byId;
  const rows = await tx
    .select({ propertyId: propertyTags.propertyId, tag: propertyTags.tag })
    .from(propertyTags)
    .where(inArray(propertyTags.propertyId, propertyIds))
    .orderBy(asc(propertyTags.tag));
  for (const r of rows) byId.set(r.propertyId, [...(byId.get(r.propertyId) ?? []), r.tag]);
  return byId;
}

// ---- Content (S3-05): translations and features -------------------------------------------------------------

export type TranslationRow = typeof propertyTranslations.$inferSelect;
export type TranslationInsert = typeof propertyTranslations.$inferInsert;

const translationColumns = {
  locale: propertyTranslations.locale,
  title: propertyTranslations.title,
  description: propertyTranslations.description,
  slug: propertyTranslations.slug,
  metaTitle: propertyTranslations.metaTitle,
  metaDescription: propertyTranslations.metaDescription,
  origin: propertyTranslations.origin,
  locked: propertyTranslations.locked,
  updatedAt: propertyTranslations.updatedAt,
};
export type TranslationView = { [K in keyof typeof translationColumns]: TranslationRow[K] };

/** A listing's translations by locale (primary key `(property_id, locale)`). */
export async function listTranslations(tx: Tx, propertyId: string): Promise<TranslationView[]> {
  return tx
    .select(translationColumns)
    .from(propertyTranslations)
    .where(eq(propertyTranslations.propertyId, propertyId))
    .orderBy(asc(propertyTranslations.locale));
}

/** Inserts or replaces one locale's text. */
export async function upsertTranslation(tx: Tx, row: TranslationInsert): Promise<TranslationView> {
  const { propertyId: _p, agencyId: _a, locale: _l, ...changes } = row;
  const [saved] = await tx
    .insert(propertyTranslations)
    .values(row)
    .onConflictDoUpdate({
      target: [propertyTranslations.propertyId, propertyTranslations.locale],
      set: { ...changes, updatedAt: sql`now()` },
    })
    .returning(translationColumns);
  return saved as TranslationView;
}

/** True when a row was deleted. */
export async function deleteTranslation(tx: Tx, propertyId: string, locale: string): Promise<boolean> {
  const rows = await tx
    .delete(propertyTranslations)
    .where(and(eq(propertyTranslations.propertyId, propertyId), eq(propertyTranslations.locale, locale)))
    .returning({ locale: propertyTranslations.locale });
  return rows.length > 0;
}

/** A listing's feature ids (primary key `(property_id, feature_id)`). */
export async function listFeatureIds(tx: Tx, propertyId: string): Promise<string[]> {
  const rows = await tx
    .select({ featureId: propertyFeatures.featureId })
    .from(propertyFeatures)
    .where(eq(propertyFeatures.propertyId, propertyId))
    .orderBy(asc(propertyFeatures.featureId));
  return rows.map((r) => r.featureId);
}

/** Replaces the listing's features with `featureIds`: one delete of the dropped, one insert of the new. */
export async function replaceFeatures(
  tx: Tx,
  ref: { propertyId: string; agencyId: string },
  featureIds: readonly string[],
): Promise<void> {
  await tx
    .delete(propertyFeatures)
    .where(
      and(
        eq(propertyFeatures.propertyId, ref.propertyId),
        featureIds.length > 0 ? notInArray(propertyFeatures.featureId, [...featureIds]) : undefined,
      ),
    );
  if (featureIds.length === 0) return;
  await tx
    .insert(propertyFeatures)
    .values(featureIds.map((featureId) => ({ ...ref, featureId })))
    .onConflictDoNothing();
}

/** Bumps the listing's `version` (content changes count as listing changes); null when `version` is stale. */
export async function bumpVersion(tx: Tx, id: string, version: number): Promise<number | null> {
  const [row] = await tx
    .update(properties)
    .set({ version: sql`${properties.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(properties.id, id), eq(properties.version, version)))
    .returning({ version: properties.version });
  return row?.version ?? null;
}

// ---- Saved views (S3-07) -------------------------------------------------------------------------------------

const viewColumns = {
  id: listingViews.id,
  name: listingViews.name,
  query: listingViews.query,
  columns: listingViews.columns,
  updatedAt: listingViews.updatedAt,
};
export type ViewRow = { [K in keyof typeof viewColumns]: (typeof listingViews.$inferSelect)[K] };

/** A member's views by name (`listing_views_member_name_uq`); a member has at most `LISTING_VIEWS_MAX`. */
export async function listViews(tx: Tx, agencyId: string, userId: string, limit: number): Promise<ViewRow[]> {
  return tx
    .select(viewColumns)
    .from(listingViews)
    .where(and(eq(listingViews.agencyId, agencyId), eq(listingViews.userId, userId)))
    .orderBy(asc(listingViews.name))
    .limit(limit);
}

/** Inserts the view unless the member already has `max` (a soft cap: two saves at once may pass it). */
export async function insertView(
  tx: Tx,
  row: { id: string; agencyId: string; userId: string; name: string; query: unknown; columns: string[] },
  max: number,
): Promise<ViewRow | null> {
  const [{ n } = { n: 0 }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(listingViews)
    .where(and(eq(listingViews.agencyId, row.agencyId), eq(listingViews.userId, row.userId)));
  if (n >= max) return null;
  const [saved] = await tx.insert(listingViews).values(row).returning(viewColumns);
  return saved ?? null;
}

export async function updateView(
  tx: Tx,
  ref: { id: string; agencyId: string; userId: string },
  patch: { name: string; query: unknown; columns: string[] },
): Promise<ViewRow | null> {
  const [saved] = await tx
    .update(listingViews)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(
      and(eq(listingViews.id, ref.id), eq(listingViews.agencyId, ref.agencyId), eq(listingViews.userId, ref.userId)),
    )
    .returning(viewColumns);
  return saved ?? null;
}

/** True when a row was deleted. */
export async function deleteView(tx: Tx, ref: { id: string; agencyId: string; userId: string }): Promise<boolean> {
  const rows = await tx
    .delete(listingViews)
    .where(
      and(eq(listingViews.id, ref.id), eq(listingViews.agencyId, ref.agencyId), eq(listingViews.userId, ref.userId)),
    )
    .returning({ id: listingViews.id });
  return rows.length > 0;
}

// ---- Bulk actions (S3-07) ------------------------------------------------------------------------------------

export type BulkInsert = typeof listingBulkActions.$inferInsert;
const bulkColumns = {
  id: listingBulkActions.id,
  createdByUserId: listingBulkActions.createdByUserId,
  type: listingBulkActions.type,
  params: listingBulkActions.params,
  state: listingBulkActions.state,
  total: listingBulkActions.total,
  processed: listingBulkActions.processed,
  succeeded: listingBulkActions.succeeded,
  unchanged: listingBulkActions.unchanged,
  failed: listingBulkActions.failed,
  failures: listingBulkActions.failures,
  error: listingBulkActions.error,
  createdAt: listingBulkActions.createdAt,
  finishedAt: listingBulkActions.finishedAt,
};
export type BulkRow = { [K in keyof typeof bulkColumns]: (typeof listingBulkActions.$inferSelect)[K] };

export async function insertBulk(tx: Tx, row: BulkInsert): Promise<BulkRow> {
  const [created] = await tx.insert(listingBulkActions).values(row).returning(bulkColumns);
  return created as BulkRow;
}

/** The record without its listing ids (they can be 5,000). */
export async function getBulk(tx: Tx, agencyId: string, id: string): Promise<BulkRow | null> {
  const [row] = await tx
    .select(bulkColumns)
    .from(listingBulkActions)
    .where(and(eq(listingBulkActions.id, id), eq(listingBulkActions.agencyId, agencyId)));
  return row ?? null;
}

export type BulkHead = Pick<BulkRow, 'createdByUserId' | 'type' | 'params' | 'state' | 'total' | 'processed'> & {
  /** Failures kept so far. */
  kept: number;
  /** The next listing ids to process. */
  chunk: string[];
};

/** Locks the record (one chunk at a time, even if a job runs twice) and reads the next `size` listing ids. */
export async function lockBulkChunk(tx: Tx, agencyId: string, id: string, size: number): Promise<BulkHead | null> {
  const res = await tx.execute<{
    createdByUserId: string;
    type: BulkRow['type'];
    params: unknown;
    state: BulkRow['state'];
    total: number;
    processed: number;
    kept: number;
    chunk: string[] | null;
  }>(sql`
    select created_by_user_id as "createdByUserId", type, params, state, total, processed,
           jsonb_array_length(failures) as kept,
           listing_ids[processed + 1 : processed + ${size}::int] as chunk
      from ${listingBulkActions}
     where id = ${id} and agency_id = ${agencyId}
       for update`);
  const row = res.rows[0];
  return row ? { ...row, chunk: row.chunk ?? [] } : null;
}

/** Counts one processed chunk; DONE when it was the last one. */
export async function advanceBulk(
  tx: Tx,
  id: string,
  step: { processed: number; succeeded: number; unchanged: number; failed: number; failures: unknown[] },
): Promise<{ processed: number; total: number; state: BulkRow['state'] }> {
  const [row] = await tx
    .update(listingBulkActions)
    .set({
      processed: sql`${listingBulkActions.processed} + ${step.processed}`,
      succeeded: sql`${listingBulkActions.succeeded} + ${step.succeeded}`,
      unchanged: sql`${listingBulkActions.unchanged} + ${step.unchanged}`,
      failed: sql`${listingBulkActions.failed} + ${step.failed}`,
      failures: sql`${listingBulkActions.failures} || ${JSON.stringify(step.failures)}::jsonb`,
      state: sql`case when ${listingBulkActions.processed} + ${step.processed} >= ${listingBulkActions.total}
        then 'DONE' else 'RUNNING' end::listing_bulk_state`,
      finishedAt: sql`case when ${listingBulkActions.processed} + ${step.processed} >= ${listingBulkActions.total}
        then now() end`,
      updatedAt: sql`now()`,
    })
    .where(eq(listingBulkActions.id, id))
    .returning({
      processed: listingBulkActions.processed,
      total: listingBulkActions.total,
      state: listingBulkActions.state,
    });
  return row as { processed: number; total: number; state: BulkRow['state'] };
}

/**
 * The action stopped for good (the member left, retries exhausted); `error` is a code, never a message. Runs
 * under `withSystem` (the member may be gone), so it names the agency too.
 */
export async function failBulk(tx: Tx, agencyId: string, id: string, error: string): Promise<void> {
  await tx
    .update(listingBulkActions)
    .set({ state: 'FAILED', error, finishedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(listingBulkActions.id, id),
        eq(listingBulkActions.agencyId, agencyId),
        inArray(listingBulkActions.state, ['QUEUED', 'RUNNING']),
      ),
    );
}

/**
 * Marks FAILED (`STALLED`) every waiting or running action not moved since `before` (all agencies, `withSystem`;
 * the partial `listing_bulk_actions_member_active_uq` holds exactly these rows). Answers how many.
 */
export async function failStaleBulks(tx: Tx, before: Date): Promise<number> {
  const rows = await tx
    .update(listingBulkActions)
    .set({ state: 'FAILED', error: 'STALLED', finishedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(inArray(listingBulkActions.state, ['QUEUED', 'RUNNING']), lt(listingBulkActions.updatedAt, before)))
    .returning({ id: listingBulkActions.id });
  return rows.length;
}

const bulkTargetColumns = {
  id: properties.id,
  agencyId: properties.agencyId,
  ownerUserId: properties.ownerUserId,
  status: properties.status,
  visibility: properties.visibility,
  shareScope: properties.shareScope,
  transactionType: properties.transactionType,
  priceCents: properties.priceCents,
  currency: properties.currency,
  energyRating: properties.energyRating,
  networkHiddenAt: properties.networkHiddenAt,
  version: properties.version,
};
export type BulkTargetRow = { [K in keyof typeof bulkTargetColumns]: ListingRow[K] };

/** The agency's own live listings among `ids`, row-locked in id order (two bulk actions never deadlock). */
export async function lockOwnMany(tx: Tx, agencyId: string, ids: string[]): Promise<BulkTargetRow[]> {
  if (ids.length === 0) return [];
  return tx
    .select(bulkTargetColumns)
    .from(properties)
    .where(and(eq(properties.agencyId, agencyId), inArray(properties.id, ids), isNull(properties.deletedAt)))
    .orderBy(asc(properties.id))
    .for('update');
}

/** One patch for every listing in `ids` (already locked); bumps `version` and `updated_at`. */
export async function updateMany(
  tx: Tx,
  ids: string[],
  patch: Partial<
    Pick<
      ListingInsert,
      | 'status'
      | 'visibility'
      | 'shareScope'
      | 'ownerUserId'
      | 'lastConfirmedAt'
      | 'confirmPromptedAt'
      | 'networkHiddenAt'
    >
  >,
): Promise<{ id: string; version: number }[]> {
  if (ids.length === 0) return [];
  return tx
    .update(properties)
    .set({ ...patch, version: sql`${properties.version} + 1`, updatedAt: sql`now()` })
    .where(inArray(properties.id, ids))
    .returning({ id: properties.id, version: properties.version });
}

/** A price per listing (already locked), one statement; bumps `version` and `updated_at`. */
export async function setPrices(
  tx: Tx,
  prices: { id: string; priceCents: number }[],
): Promise<{ id: string; version: number }[]> {
  if (prices.length === 0) return [];
  const res = await tx.execute<{ id: string; version: number }>(sql`
    update ${properties} p
       set price_cents = v.price, version = p.version + 1, updated_at = now()
      from unnest(array[${sql.join(
        prices.map((p) => sql`${p.id}`),
        sql`, `,
      )}]::uuid[], array[${sql.join(
        prices.map((p) => sql`${p.priceCents}`),
        sql`, `,
      )}]::bigint[]) as v(id, price)
     where p.id = v.id
    returning p.id, p.version`);
  return res.rows;
}

/** Bumps `version` and `updated_at` of listings whose content changed (tags). */
export async function bumpVersions(tx: Tx, ids: string[]): Promise<{ id: string; version: number }[]> {
  if (ids.length === 0) return [];
  return tx
    .update(properties)
    .set({ version: sql`${properties.version} + 1`, updatedAt: sql`now()` })
    .where(inArray(properties.id, ids))
    .returning({ id: properties.id, version: properties.version });
}

/** Adds `tag` to the listings that lack it; answers the listings that got it. */
export async function addTag(tx: Tx, agencyId: string, ids: string[], tag: string): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .insert(propertyTags)
    .values(ids.map((propertyId) => ({ propertyId, agencyId, tag })))
    .onConflictDoNothing()
    .returning({ propertyId: propertyTags.propertyId });
  return rows.map((r) => r.propertyId);
}

export async function insertPriceHistories(
  tx: Tx,
  rows: (typeof propertyPriceHistories.$inferInsert)[],
): Promise<void> {
  if (rows.length > 0) await tx.insert(propertyPriceHistories).values(rows);
}

export async function insertStatusHistories(
  tx: Tx,
  rows: (typeof propertyStatusHistories.$inferInsert)[],
): Promise<void> {
  if (rows.length > 0) await tx.insert(propertyStatusHistories).values(rows);
}

// ---- Quality and freshness (S3-08) ---------------------------------------------------------------------------

const qualityColumns = {
  agencyId: properties.agencyId,
  status: properties.status,
  energyRating: properties.energyRating,
  lat: properties.lat,
  locationPrecision: properties.locationPrecision,
  lastConfirmedAt: properties.lastConfirmedAt,
  networkHiddenAt: properties.networkHiddenAt,
  qualityScore: properties.qualityScore,
};
export type QualityRow = { [K in keyof typeof qualityColumns]: ListingRow[K] };

/** What the quality score reads of a listing visible to the caller (primary key); null if none. */
export async function qualityRow(tx: Tx, id: string): Promise<QualityRow | null> {
  const [row] = await tx.select(qualityColumns).from(properties).where(eq(properties.id, id));
  return row ?? null;
}

/** Each translation's locale and description length (characters, trimmed); `property_translations` PK. */
export async function descriptionLengths(tx: Tx, propertyId: string): Promise<{ locale: string; length: number }[]> {
  return tx
    .select({
      locale: propertyTranslations.locale,
      length: sql<number>`coalesce(char_length(btrim(${propertyTranslations.description})), 0)::int`,
    })
    .from(propertyTranslations)
    .where(eq(propertyTranslations.propertyId, propertyId));
}

/** Stores a recomputed score (no `version` bump: derived data); true when it changed. */
export async function setQualityScore(tx: Tx, id: string, score: number): Promise<boolean> {
  const rows = await tx
    .update(properties)
    .set({ qualityScore: score })
    .where(and(eq(properties.id, id), sql`${properties.qualityScore} is distinct from ${score}`))
    .returning({ id: properties.id });
  return rows.length > 0;
}

export type SweptRow = { id: string; agencyId: string; version: number; visibility: string; shareScope: string };

/**
 * Freshness sweep (all agencies, `withSystem`): marks up to `limit` active listings last confirmed before `before`
 * as prompted (`confirm_prompted_at`), oldest first, skipping rows locked by an edit
 * (`properties_confirm_prompt_idx`). No version bump: the listing itself did not change.
 */
export async function markConfirmPrompted(tx: Tx, before: Date, limit: number): Promise<SweptRow[]> {
  const res = await tx.execute<SweptRow>(sql`
    update ${properties} p set confirm_prompted_at = now()
    where p.id in (
      select id from ${properties}
      where status = 'ACTIVE' and deleted_at is null and confirm_prompted_at is null and last_confirmed_at < ${before}
      order by last_confirmed_at limit ${limit} for update skip locked)
    returning p.id, p.agency_id as "agencyId", p.version, p.visibility, p.share_scope as "shareScope"`);
  return res.rows;
}

/**
 * Freshness sweep: hides from the network up to `limit` active listings last confirmed before `before`
 * (`network_hidden_at`, read by the RLS network predicate), oldest first (`properties_network_hide_idx`). For a
 * shared or public listing that is a network change: `version` and `updated_at` move so read models and search
 * rebuild. A private one only gets the flag (it stays hidden if shared later, until confirmed): no version bump,
 * so an editor open on it is not interrupted.
 */
export async function hideFromNetwork(tx: Tx, before: Date, limit: number): Promise<SweptRow[]> {
  const res = await tx.execute<SweptRow>(sql`
    update ${properties} p set network_hidden_at = now(),
      version = case when p.visibility = 'PRIVATE' then p.version else p.version + 1 end,
      updated_at = case when p.visibility = 'PRIVATE' then p.updated_at else now() end
    where p.id in (
      select id from ${properties}
      where status = 'ACTIVE' and deleted_at is null and network_hidden_at is null and last_confirmed_at < ${before}
      order by last_confirmed_at limit ${limit} for update skip locked)
    returning p.id, p.agency_id as "agencyId", p.version, p.visibility, p.share_scope as "shareScope"`);
  return res.rows;
}
