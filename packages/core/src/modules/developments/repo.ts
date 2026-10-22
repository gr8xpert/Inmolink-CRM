/**
 * developments queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/developments` — other modules' tables fail `pnpm check:boundaries`.
 */
import type { Tx } from '@inmolink/db';
import {
  developmentAccess,
  developmentDocuments,
  developmentPhases,
  developments,
  developmentTranslations,
  priceLists,
  unitPriceHistories,
  unitStatusHistories,
  units,
} from '@inmolink/db/schema/developments';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  type SQL,
  sql,
} from 'drizzle-orm';
import { type KeysetCursor, keysetAfter, keysetOrder } from '../../pagination';

/**
 * `legacy_id` (developments) and `uploaded_by` (documents) are owner-only data on rows other agencies read:
 * `app_user` has no SELECT on them (registry `hiddenColumns`, S5-F1), so every read and RETURNING names the
 * columns below. The legacy import and support read them as `app_system`.
 */
const { legacyId: _legacyId, ...developmentColumns } = getTableColumns(developments);
const { uploadedBy: _uploadedBy, ...documentColumns } = getTableColumns(developmentDocuments);
/** S5-F3: lists select the DTO's columns only — `toDevelopmentDto` and `toUnitDto` read nothing else. */
const { deletedAt: _deletedAt, ...developmentListColumns } = developmentColumns;
const { agencyId: _unitAgencyId, createdAt: _unitCreatedAt, ...unitListColumns } = getTableColumns(units);
/** A price list without its lines (up to 2,000): no read path returns them (S5-F3). */
const { entries: _entries, ...priceListColumns } = getTableColumns(priceLists);

/** Column sets of the list queries, for the S5-F3 test that they stay narrow. */
export const listColumns = {
  developments: Object.keys(developmentListColumns),
  units: Object.keys(unitListColumns),
};

export type DevelopmentRow = Omit<typeof developments.$inferSelect, 'legacyId'>;
export type DevelopmentListRow = Omit<DevelopmentRow, 'deletedAt'>;
export type DevelopmentInsert = typeof developments.$inferInsert;
export type UnitRow = typeof units.$inferSelect;
export type UnitListRow = Omit<UnitRow, 'agencyId' | 'createdAt'>;
export type UnitInsert = typeof units.$inferInsert;
export type PriceListRow = Omit<typeof priceLists.$inferSelect, 'entries'>;
export type PriceListSummaryRow = Omit<PriceListRow, 'diffSummary'> & {
  counts: { added: number; removed: number; changed: number; unchanged: number };
};
export type DocumentRow = Omit<typeof developmentDocuments.$inferSelect, 'uploadedBy'>;

// ── Developments ─────────────────────────────────────────────────────────────────────────────────────────────

export async function insertDevelopment(tx: Tx, row: DevelopmentInsert): Promise<DevelopmentRow> {
  const [inserted] = await tx.insert(developments).values(row).returning(developmentColumns);
  return inserted as DevelopmentRow;
}

/** A development the caller can read (own or shared through RLS), not deleted. */
export async function getDevelopment(tx: Tx, id: string): Promise<DevelopmentRow | null> {
  const [row] = await tx
    .select(developmentColumns)
    .from(developments)
    .where(and(eq(developments.id, id), isNull(developments.deletedAt)));
  return row ?? null;
}

/** The agency's own, not deleted development, row-locked: changes of one development run one after another. */
export async function getOwnForUpdate(tx: Tx, agencyId: string, id: string): Promise<DevelopmentRow | null> {
  const [row] = await tx
    .select(developmentColumns)
    .from(developments)
    .where(and(eq(developments.id, id), eq(developments.agencyId, agencyId), isNull(developments.deletedAt)))
    .for('update');
  return row ?? null;
}

export async function updateDevelopment(
  tx: Tx,
  id: string,
  version: number,
  patch: Partial<DevelopmentInsert>,
): Promise<DevelopmentRow | null> {
  const [row] = await tx
    .update(developments)
    .set({ ...patch, version: sql`${developments.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(developments.id, id), eq(developments.version, version)))
    .returning(developmentColumns);
  return row ?? null; // null → version conflict
}

/** The agency's developments, newest first (`developments_agency_created_idx`). */
export async function listOwnDevelopments(
  tx: Tx,
  agencyId: string,
  q: { limit: number; cursor?: KeysetCursor },
): Promise<{ items: DevelopmentListRow[]; hasMore: boolean }> {
  const rows = await tx
    .select(developmentListColumns)
    .from(developments)
    .where(
      and(
        eq(developments.agencyId, agencyId),
        isNull(developments.deletedAt),
        keysetAfter(developments.createdAt, developments.id, q.cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrder(developments.createdAt, developments.id, 'desc'))
    .limit(q.limit + 1);
  return { items: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
}

/** The agencies named for each development (the owner's view). One statement. */
export async function accessOf(tx: Tx, developmentIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(developmentIds.map((id) => [id, []]));
  if (developmentIds.length === 0) return out;
  const rows = await tx
    .select({ developmentId: developmentAccess.developmentId, agencyId: developmentAccess.allowedAgencyId })
    .from(developmentAccess)
    .where(inArray(developmentAccess.developmentId, [...developmentIds]))
    .orderBy(asc(developmentAccess.developmentId), asc(developmentAccess.allowedAgencyId));
  for (const r of rows) out.get(r.developmentId)?.push(r.agencyId);
  return out;
}

/** Replaces the allowed agencies of a development (two statements at most). */
export async function replaceAccess(
  tx: Tx,
  dev: { id: string; agencyId: string },
  allowedAgencyIds: readonly string[],
): Promise<void> {
  await tx.delete(developmentAccess).where(eq(developmentAccess.developmentId, dev.id));
  if (allowedAgencyIds.length === 0) return;
  await tx
    .insert(developmentAccess)
    .values(allowedAgencyIds.map((a) => ({ developmentId: dev.id, agencyId: dev.agencyId, allowedAgencyId: a })));
}

// ── Units ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The owner agency of a unit the caller can read (RLS), its development not deleted. */
export async function getUnitOwner(tx: Tx, id: string): Promise<string | null> {
  const [row] = await tx
    .select({ agencyId: units.agencyId })
    .from(units)
    .innerJoin(developments, eq(developments.id, units.developmentId))
    .where(and(eq(units.id, id), isNull(developments.deletedAt)));
  return row?.agencyId ?? null;
}

export async function countUnits(tx: Tx, developmentId: string): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(units).where(eq(units.developmentId, developmentId));
  return row?.n ?? 0;
}

export async function insertUnits(tx: Tx, rows: UnitInsert[]): Promise<UnitRow[]> {
  return tx.insert(units).values(rows).returning();
}

/** The development's units by reference (`units_development_ref_uq`), keyset on the reference. */
export async function listUnits(
  tx: Tx,
  developmentId: string,
  q: { limit: number; afterRef?: string; status?: UnitRow['status'] },
): Promise<{ items: UnitListRow[]; hasMore: boolean }> {
  const rows = await tx
    .select(unitListColumns)
    .from(units)
    .where(
      and(
        eq(units.developmentId, developmentId),
        q.status ? eq(units.status, q.status) : undefined,
        q.afterRef === undefined ? undefined : gt(units.ref, q.afterRef),
      ),
    )
    .orderBy(asc(units.ref))
    .limit(q.limit + 1);
  return { items: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
}

export type UnitPriceRow = Pick<UnitRow, 'id' | 'ref' | 'priceCents' | 'status' | 'currency'>;

/**
 * Every unit of a development (at most `MAX_UNITS_PER_DEVELOPMENT`), locked for a price list apply: the columns
 * the diff compares and the price history records.
 */
export async function unitPricesForUpdate(tx: Tx, developmentId: string): Promise<UnitPriceRow[]> {
  return tx
    .select({
      id: units.id,
      ref: units.ref,
      priceCents: units.priceCents,
      status: units.status,
      currency: units.currency,
    })
    .from(units)
    .where(eq(units.developmentId, developmentId))
    .orderBy(asc(units.ref))
    .for('update');
}

/** Every unit of a development (at most `MAX_UNITS_PER_DEVELOPMENT`): the columns a price list diff compares. */
export async function unitPrices(
  tx: Tx,
  developmentId: string,
): Promise<Pick<UnitRow, 'id' | 'ref' | 'priceCents' | 'status'>[]> {
  return tx
    .select({ id: units.id, ref: units.ref, priceCents: units.priceCents, status: units.status })
    .from(units)
    .where(eq(units.developmentId, developmentId))
    .orderBy(asc(units.ref));
}

/**
 * Units of the development by id, row-locked (one statement): the DTO's columns only — what an edit compares and
 * audits (`toUnitDto`, status, price, commission), not the agency or creation time (S6-F2).
 */
export async function unitsForUpdate(tx: Tx, developmentId: string, ids: readonly string[]): Promise<UnitListRow[]> {
  return tx
    .select(unitListColumns)
    .from(units)
    .where(and(eq(units.developmentId, developmentId), inArray(units.id, [...ids])))
    .orderBy(asc(units.ref))
    .for('update');
}

export async function updateUnit(
  tx: Tx,
  id: string,
  version: number,
  patch: Partial<UnitInsert>,
): Promise<UnitRow | null> {
  const [row] = await tx
    .update(units)
    .set({ ...patch, version: sql`${units.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(units.id, id), eq(units.version, version)))
    .returning();
  return row ?? null;
}

/** The same patch on many units of one development (one statement). */
export async function updateUnits(
  tx: Tx,
  developmentId: string,
  ids: readonly string[],
  patch: Partial<UnitInsert>,
): Promise<UnitRow[]> {
  return tx
    .update(units)
    .set({ ...patch, version: sql`${units.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(units.developmentId, developmentId), inArray(units.id, [...ids])))
    .returning();
}

/**
 * One bind parameter per column, whatever the row count (S5-F3): a 2,000-unit repricing as `unnest` of arrays
 * binds in a few milliseconds, where a VALUES row per unit (16,000 parameters) took ~200 ms per statement.
 */
const array = (values: readonly unknown[], type: string) => sql`${sql.param(values)}::${sql.raw(type)}[]`;

/**
 * A price and status per unit of one development (a price list apply), one statement. The development filter keeps
 * the plan on `units_development_ref_uq`: joined on `id` alone, a loaded planner scanned other agencies' units and
 * ran the network-read policy's subqueries per row (statement timeout in a full verify).
 */
export async function setUnitPrices(
  tx: Tx,
  developmentId: string,
  values: readonly { id: string; priceCents: number | null; status: UnitRow['status'] }[],
): Promise<void> {
  if (values.length === 0) return;
  const v = sql`v`;
  await tx
    .update(units)
    .set({
      priceCents: sql`${v}.price_cents`,
      status: sql`${v}.status`,
      version: sql`${units.version} + 1`,
      updatedAt: sql`now()`,
    })
    .from(
      sql`unnest(${array(
        values.map((r) => r.id),
        'uuid',
      )}, ${array(
        values.map((r) => r.priceCents),
        'bigint',
      )}, ${array(
        values.map((r) => r.status),
        'unit_status',
      )}) as v(id, price_cents, status)`,
    )
    .where(and(eq(units.developmentId, developmentId), sql`${units.id} = ${v}.id`));
}

/**
 * The history rows of an approved price list (S5-F3), or of a feed's changes (`priceListId` null, S8-F3): two
 * statements, each one parameter per column.
 */
export async function insertPriceListHistories(
  tx: Tx,
  h: {
    agencyId: string;
    priceListId: string | null;
    changedByUserId: string | null;
    prices: readonly { id: string; unitId: string; from: number | null; to: number | null; currency: string }[];
    statuses: readonly { id: string; unitId: string; from: UnitRow['status'] | null; to: UnitRow['status'] }[];
  },
): Promise<void> {
  const { agencyId, priceListId, changedByUserId: by } = h;
  if (h.prices.length > 0) {
    const p = h.prices;
    await tx.execute(sql`insert into ${unitPriceHistories}
        (id, unit_id, agency_id, price_list_id, previous_price_cents, price_cents, currency, changed_by_user_id)
      select v.id, v.unit_id, ${agencyId}::uuid, ${priceListId}::uuid, v.prev, v.price, v.currency, ${by}::uuid
        from unnest(${array(
          p.map((r) => r.id),
          'uuid',
        )}, ${array(
          p.map((r) => r.unitId),
          'uuid',
        )}, ${array(
          p.map((r) => r.from),
          'bigint',
        )}, ${array(
          p.map((r) => r.to),
          'bigint',
        )}, ${array(
          p.map((r) => r.currency),
          'text',
        )}) as v(id, unit_id, prev, price, currency)`);
  }
  if (h.statuses.length > 0) {
    const s = h.statuses;
    await tx.execute(sql`insert into ${unitStatusHistories}
        (id, unit_id, agency_id, price_list_id, from_status, to_status, changed_by_user_id)
      select v.id, v.unit_id, ${agencyId}::uuid, ${priceListId}::uuid, v.from_status, v.to_status, ${by}::uuid
        from unnest(${array(
          s.map((r) => r.id),
          'uuid',
        )}, ${array(
          s.map((r) => r.unitId),
          'uuid',
        )}, ${array(
          s.map((r) => r.from),
          'unit_status',
        )}, ${array(
          s.map((r) => r.to),
          'unit_status',
        )}) as v(id, unit_id, from_status, to_status)`);
  }
}

export async function deleteUnit(tx: Tx, developmentId: string, id: string): Promise<boolean> {
  const rows = await tx
    .delete(units)
    .where(and(eq(units.developmentId, developmentId), eq(units.id, id)))
    .returning({ id: units.id });
  return rows.length > 0;
}

export async function insertPriceHistories(tx: Tx, rows: (typeof unitPriceHistories.$inferInsert)[]): Promise<void> {
  if (rows.length > 0) await tx.insert(unitPriceHistories).values(rows);
}

export async function insertStatusHistories(tx: Tx, rows: (typeof unitStatusHistories.$inferInsert)[]): Promise<void> {
  if (rows.length > 0) await tx.insert(unitStatusHistories).values(rows);
}

// ── Price lists ──────────────────────────────────────────────────────────────────────────────────────────────

/** The development's latest price list version (0 when none). Callers hold the development's row lock. */
export async function latestPriceListVersion(tx: Tx, developmentId: string): Promise<number> {
  const [row] = await tx
    .select({ v: sql<number>`coalesce(max(${priceLists.version}), 0)::int` })
    .from(priceLists)
    .where(eq(priceLists.developmentId, developmentId));
  return row?.v ?? 0;
}

export async function insertPriceList(tx: Tx, row: typeof priceLists.$inferInsert): Promise<PriceListRow> {
  const [inserted] = await tx.insert(priceLists).values(row).returning(priceListColumns);
  return inserted as PriceListRow;
}

/** One version without its lines (the read path). */
export async function getPriceList(tx: Tx, developmentId: string, version: number): Promise<PriceListRow | null> {
  const [row] = await tx
    .select(priceListColumns)
    .from(priceLists)
    .where(and(eq(priceLists.developmentId, developmentId), eq(priceLists.version, version)));
  return row ?? null;
}

/** One version to approve: its lines and the development's latest version, one statement. */
export async function getPriceListToApprove(
  tx: Tx,
  developmentId: string,
  version: number,
): Promise<(PriceListRow & { entries: unknown; latestVersion: number }) | null> {
  const latest = tx
    .select({ v: sql<number>`max(${priceLists.version})` })
    .from(priceLists)
    .where(eq(priceLists.developmentId, developmentId));
  const [row] = await tx
    .select({ ...priceListColumns, entries: priceLists.entries, latestVersion: sql<number>`(${latest})::int` })
    .from(priceLists)
    .where(and(eq(priceLists.developmentId, developmentId), eq(priceLists.version, version)));
  return row ?? null;
}

export async function markPriceListReviewed(
  tx: Tx,
  id: string,
  patch: { reviewedByUserId: string; diffSummary: unknown },
): Promise<PriceListRow> {
  const [row] = await tx
    .update(priceLists)
    .set({ ...patch, reviewedAt: sql`now()` })
    .where(eq(priceLists.id, id))
    .returning(priceListColumns);
  return row as PriceListRow;
}

/** The development's versions, latest first (`price_lists_development_version_uq`). */
export async function listPriceLists(
  tx: Tx,
  developmentId: string,
  q: { limit: number; beforeVersion?: number },
): Promise<{ items: PriceListSummaryRow[]; hasMore: boolean }> {
  const where: (SQL | undefined)[] = [
    eq(priceLists.developmentId, developmentId),
    q.beforeVersion === undefined ? undefined : lt(priceLists.version, q.beforeVersion),
  ];
  // entries and the diff hold up to 2,000 and 4,000 lines each: a list carries the diff's counts only (S4-F5).
  const { diffSummary: _diff, ...summaryColumns } = priceListColumns;
  const d = priceLists.diffSummary;
  const rows = await tx
    .select({
      ...summaryColumns,
      counts: sql<PriceListSummaryRow['counts']>`jsonb_build_object(
        'added', jsonb_array_length(${d}->'added'),
        'removed', jsonb_array_length(${d}->'removed'),
        'changed', jsonb_array_length(${d}->'changed'),
        'unchanged', (${d}->>'unchanged')::int)`,
    })
    .from(priceLists)
    .where(and(...where))
    .orderBy(desc(priceLists.version))
    .limit(q.limit + 1);
  return { items: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
}

// ── Documents (S4-F4) ────────────────────────────────────────────────────────────────────────────────────────

/** A development's documents the caller can read (RLS: the owner's all, another agency's the shared ones). */
export async function listDocuments(tx: Tx, developmentId: string): Promise<DocumentRow[]> {
  return tx
    .select(documentColumns)
    .from(developmentDocuments)
    .where(eq(developmentDocuments.developmentId, developmentId))
    .orderBy(asc(developmentDocuments.createdAt), asc(developmentDocuments.id))
    .limit(500); // bounded: an upload caps a development at DEVELOPMENT_DOCUMENTS_MAX
}

/** One document of the development the caller can read (RLS), or null. */
export async function getDocument(tx: Tx, developmentId: string, id: string): Promise<DocumentRow | null> {
  const [row] = await tx
    .select(documentColumns)
    .from(developmentDocuments)
    .where(and(eq(developmentDocuments.id, id), eq(developmentDocuments.developmentId, developmentId)));
  return row ?? null;
}

export async function insertDocument(tx: Tx, row: typeof developmentDocuments.$inferInsert): Promise<DocumentRow> {
  const [inserted] = await tx.insert(developmentDocuments).values(row).returning(documentColumns);
  return inserted as DocumentRow;
}

export async function updateDocument(
  tx: Tx,
  agencyId: string,
  developmentId: string,
  id: string,
  patch: Partial<Pick<DocumentRow, 'kind' | 'shared'>>,
): Promise<DocumentRow | null> {
  const [row] = await tx
    .update(developmentDocuments)
    .set(patch)
    .where(
      and(
        eq(developmentDocuments.id, id),
        eq(developmentDocuments.developmentId, developmentId),
        eq(developmentDocuments.agencyId, agencyId),
      ),
    )
    .returning(documentColumns);
  return row ?? null;
}

/**
 * Deletes the own document; price lists that named it as their source keep their entries and lose the link
 * (`price_lists_source_document_fk` has no cascade). Two statements; false when there was no such document.
 */
export async function deleteDocument(tx: Tx, agencyId: string, developmentId: string, id: string): Promise<boolean> {
  await tx
    .update(priceLists)
    .set({ sourceDocumentId: null })
    .where(
      and(
        eq(priceLists.sourceDocumentId, id),
        eq(priceLists.developmentId, developmentId),
        eq(priceLists.agencyId, agencyId),
      ),
    );
  const rows = await tx
    .delete(developmentDocuments)
    .where(
      and(
        eq(developmentDocuments.id, id),
        eq(developmentDocuments.developmentId, developmentId),
        eq(developmentDocuments.agencyId, agencyId),
      ),
    )
    .returning({ id: developmentDocuments.id });
  return rows.length > 0;
}

/** Which of `keys` a document row still names (`development_documents_key_uq`); the orphan sweep (system). */
export async function existingDocumentKeys(tx: Tx, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await tx
    .select({ key: developmentDocuments.storageKey })
    .from(developmentDocuments)
    .where(inArray(developmentDocuments.storageKey, keys));
  return new Set(rows.map((r) => r.key));
}

// ---- Purge (S5-F2, withSystem) -----------------------------------------------------------------------------------

/**
 * Up to `limit` developments soft-deleted before `before` (all agencies), longest deleted first, rows locked
 * (skipping those another purge holds). Served by the partial `developments_deleted_idx`.
 */
export async function dueForPurge(tx: Tx, before: Date, limit: number): Promise<{ id: string; agencyId: string }[]> {
  return tx
    .select({ id: developments.id, agencyId: developments.agencyId })
    .from(developments)
    .where(and(isNotNull(developments.deletedAt), lt(developments.deletedAt, before)))
    .orderBy(asc(developments.deletedAt))
    .limit(limit)
    .for('update', { skipLocked: true });
}

/** The documents of these developments (`development_documents_development_idx`). */
export async function documentsOfDevelopments(
  tx: Tx,
  ids: readonly string[],
): Promise<{ id: string; developmentId: string; agencyId: string }[]> {
  if (ids.length === 0) return [];
  return tx
    .select({
      id: developmentDocuments.id,
      developmentId: developmentDocuments.developmentId,
      agencyId: developmentDocuments.agencyId,
    })
    .from(developmentDocuments)
    .where(inArray(developmentDocuments.developmentId, [...ids]));
}

/** Units per development of these (`units_development_ref_uq` prefix: an index-only count). */
export async function unitCountsOf(tx: Tx, ids: readonly string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ developmentId: units.developmentId, n: sql<number>`count(*)::int` })
    .from(units)
    .where(inArray(units.developmentId, [...ids]))
    .groupBy(units.developmentId);
  return new Map(rows.map((r) => [r.developmentId, r.n]));
}

/**
 * Deletes up to `limit` units of a soft-deleted development (their price and status histories cascade), so a large
 * development is purged over several bounded transactions (S6-F3). Answers how many.
 */
export async function deleteUnitsOfDeleted(tx: Tx, developmentId: string, limit: number): Promise<number> {
  const res = await tx.execute(sql`
    delete from ${units} where id in (
      select u.id from ${units} u join ${developments} d on d.id = u.development_id
       where u.development_id = ${developmentId} and d.deleted_at is not null
       limit ${limit})`);
  return res.rowCount ?? 0;
}

/** Deletes these soft-deleted developments for good (children cascade); answers the ones deleted. */
export async function purge(tx: Tx, ids: readonly string[]): Promise<{ id: string; agencyId: string }[]> {
  if (ids.length === 0) return [];
  return tx
    .delete(developments)
    .where(and(inArray(developments.id, [...ids]), isNotNull(developments.deletedAt)))
    .returning({ id: developments.id, agencyId: developments.agencyId });
}

// ---- Read models (S5-01, withSystem) ------------------------------------------------------------------------------

/** These units with their development's shown columns (unit PK, then the development's PK). Never commission. */
export async function readModelUnits(tx: Tx, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return tx
    .select({
      id: units.id,
      agencyId: units.agencyId,
      developmentId: units.developmentId,
      phaseId: units.phaseId,
      ref: units.ref,
      propertyTypeId: units.propertyTypeId,
      bedrooms: units.bedrooms,
      bathrooms: units.bathrooms,
      internalM2: units.internalM2,
      terraceM2: units.terraceM2,
      plotM2: units.plotM2,
      floor: units.floor,
      orientation: units.orientation,
      priceCents: units.priceCents,
      currency: units.currency,
      status: units.status,
      version: units.version,
      // the development's access list (`development_access` PK prefix): network search filters units by it (S5-05)
      allowedAgencyIds: sql<string[]>`array(select a.allowed_agency_id::text from ${developmentAccess} a
        where a.development_id = ${units.developmentId} order by 1)`,
      development: {
        ref: developments.ref,
        name: developments.name,
        status: developments.status,
        completionDate: developments.completionDate,
        locationId: developments.locationId,
        lat: developments.lat,
        lng: developments.lng,
        access: developments.access,
        version: developments.version,
        deletedAt: developments.deletedAt,
      },
    })
    .from(units)
    .innerJoin(developments, eq(developments.id, units.developmentId))
    .where(inArray(units.id, [...ids]));
}

/** Every translation of these developments (`development_translations` PK). */
export async function readModelDevelopmentTexts(tx: Tx, developmentIds: readonly string[]) {
  if (developmentIds.length === 0) return [];
  return (
    tx
      .select({
        developmentId: developmentTranslations.developmentId,
        locale: developmentTranslations.locale,
        title: developmentTranslations.title,
        description: developmentTranslations.description,
        paymentTerms: developmentTranslations.paymentTerms,
        slug: developmentTranslations.slug,
        metaTitle: developmentTranslations.metaTitle,
        metaDescription: developmentTranslations.metaDescription,
      })
      .from(developmentTranslations)
      .where(inArray(developmentTranslations.developmentId, [...developmentIds]))
      // a stable order: the "any locale" fallback must not flip between rebuilds
      .orderBy(asc(developmentTranslations.developmentId), asc(developmentTranslations.locale))
  );
}

/** These phases' shown columns (PK). */
export async function readModelPhases(tx: Tx, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return tx
    .select({
      id: developmentPhases.id,
      name: developmentPhases.name,
      status: developmentPhases.status,
      completionDate: developmentPhases.completionDate,
    })
    .from(developmentPhases)
    .where(inArray(developmentPhases.id, [...ids]));
}

/** Every unit id of a development (`units_development_ref_uq`; units per development are capped). */
export async function unitIdsOf(tx: Tx, developmentId: string): Promise<string[]> {
  const rows = await tx.select({ id: units.id }).from(units).where(eq(units.developmentId, developmentId));
  return rows.map((r) => r.id);
}

/**
 * The overrides cleanup's check (S6-F1): a unit is removed when no row is left; a development when no row is left, or
 * when it is `agencyId`'s and soft-deleted (it is never restored). Two primary-key lookups at most.
 */
export async function isRemoved(tx: Tx, kind: 'UNIT' | 'DEVELOPMENT', id: string, agencyId: string): Promise<boolean> {
  if (kind === 'UNIT') {
    const rows = await tx.select({ id: units.id }).from(units).where(eq(units.id, id)).limit(1);
    return rows.length === 0;
  }
  const [row] = await tx
    .select({ agencyId: developments.agencyId, deletedAt: developments.deletedAt })
    .from(developments)
    .where(eq(developments.id, id))
    .limit(1);
  return !row || (row.agencyId === agencyId && row.deletedAt !== null);
}

/** How many units of live developments there are (the full rebuild's progress), optionally one agency's. */
export async function countReadModelUnits(tx: Tx, agencyId?: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(units)
    .innerJoin(developments, eq(developments.id, units.developmentId))
    .where(and(isNull(developments.deletedAt), agencyId === undefined ? undefined : eq(units.agencyId, agencyId)));
  return row?.n ?? 0;
}

/**
 * A page of ids of units of live developments, after `after` in id order (`withSystem`, the full rebuild): the
 * units primary key walked, each unit's development by its primary key.
 */
export async function readModelUnitIdsPage(
  tx: Tx,
  page: { after: string | null; limit: number; agencyId?: string },
): Promise<string[]> {
  const rows = await tx
    .select({ id: units.id })
    .from(units)
    .innerJoin(developments, eq(developments.id, units.developmentId))
    .where(
      and(
        isNull(developments.deletedAt),
        page.after === null ? undefined : gt(units.id, page.after),
        page.agencyId === undefined ? undefined : eq(units.agencyId, page.agencyId),
      ),
    )
    .orderBy(asc(units.id))
    .limit(page.limit);
  return rows.map((r) => r.id);
}

/** Network search terms (S5-05): other agencies' units among `ids` with their development's commission, under RLS. */
export async function networkUnitTerms(tx: Tx, selfId: string, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return tx
    .select({
      id: units.id,
      agencyId: units.agencyId,
      priceCents: units.priceCents,
      currency: units.currency,
      unitCommissionBp: units.commissionBp,
      unitCommissionFixedCents: units.commissionFixedCents,
      unitCommissionIncludesVat: units.commissionIncludesVat,
      developmentCommissionBp: developments.commissionBp,
      developmentCommissionFixedCents: developments.commissionFixedCents,
      developmentCommissionIncludesVat: developments.commissionIncludesVat,
      developmentCurrency: developments.currency,
    })
    .from(units)
    .innerJoin(developments, eq(developments.id, units.developmentId))
    .where(and(inArray(units.id, [...ids]), sql`${units.agencyId} <> ${selfId}`));
}

/** Commission terms of these units (own, else their development's) for the search index (S7-F4): no RLS (`withSystem`). */
export async function commissionTermsOf(tx: Tx, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return tx
    .select({
      id: units.id,
      priceCents: units.priceCents,
      currency: units.currency,
      unitCommissionBp: units.commissionBp,
      unitCommissionFixedCents: units.commissionFixedCents,
      developmentCommissionBp: developments.commissionBp,
      developmentCommissionFixedCents: developments.commissionFixedCents,
      developmentCurrency: developments.currency,
    })
    .from(units)
    .innerJoin(developments, eq(developments.id, units.developmentId))
    .where(inArray(units.id, [...ids]));
}

// ── Feed imports (S7-F14, batched in S8-F3) ──────────────────────────────────────────────────────────────────

/**
 * The agency's developments with these references (deleted ones included: a reference stays taken), row-locked in
 * reference order (two imports of one agency lock in the same order). One statement (`developments_agency_ref_uq`).
 */
export async function ownByRefsForUpdate(tx: Tx, agencyId: string, refs: readonly string[]): Promise<DevelopmentRow[]> {
  if (refs.length === 0) return [];
  return tx
    .select(developmentColumns)
    .from(developments)
    .where(and(eq(developments.agencyId, agencyId), sql`${developments.ref} = any(${array(refs, 'text')})`))
    .orderBy(asc(developments.ref))
    .for('update');
}

/** A development a feed creates (S8-F3): PRIVATE_NETWORK, no commission, the column defaults otherwise. */
export interface FeedDevelopmentInsert {
  id: string;
  ref: string;
  name: string;
  status: DevelopmentRow['status'];
  locationId: string;
  currency: string;
}

/** Many developments of one agency in one statement (one parameter per column). Returns their ids and versions. */
export async function insertFeedDevelopments(
  tx: Tx,
  agencyId: string,
  rows: readonly FeedDevelopmentInsert[],
): Promise<{ id: string; version: number }[]> {
  if (rows.length === 0) return [];
  const col = <K extends keyof FeedDevelopmentInsert>(k: K, type: string) =>
    array(
      rows.map((r) => r[k]),
      type,
    );
  const result =
    await tx.execute(sql`insert into ${developments} (id, agency_id, ref, name, status, location_id, currency)
    select v.id, ${agencyId}::uuid, v.ref, v.name, v.status, v.location_id, v.currency
      from unnest(${col('id', 'uuid')}, ${col('ref', 'text')}, ${col('name', 'text')}, ${col('status', 'development_status')},
                  ${col('locationId', 'uuid')}, ${col('currency', 'text')}) as v(id, ref, name, status, location_id, currency)
    returning id, version`);
  return result.rows as { id: string; version: number }[];
}

/** What a feed owns of a development after creating it (S8-F3): its name, place and status. */
export interface FeedDevelopmentValues {
  id: string;
  name: string;
  locationId: string;
  status: DevelopmentRow['status'];
}

/** The feed-owned columns of many developments, one statement (one bind parameter per column). */
export async function setFeedDevelopments(
  tx: Tx,
  agencyId: string,
  values: readonly FeedDevelopmentValues[],
): Promise<DevelopmentRow[]> {
  if (values.length === 0) return [];
  const v = sql`v`;
  return tx
    .update(developments)
    .set({
      name: sql`${v}.name`,
      locationId: sql`${v}.location_id`,
      status: sql`${v}.status`,
      version: sql`${developments.version} + 1`,
      updatedAt: sql`now()`,
    })
    .from(
      sql`unnest(${array(
        values.map((r) => r.id),
        'uuid',
      )}, ${array(
        values.map((r) => r.name),
        'text',
      )}, ${array(
        values.map((r) => r.locationId),
        'uuid',
      )}, ${array(
        values.map((r) => r.status),
        'development_status',
      )}) as v(id, name, location_id, status)`,
    )
    .where(and(eq(developments.agencyId, agencyId), sql`${developments.id} = ${v}.id`))
    .returning(developmentColumns);
}

/** Every unit of these developments (each at most `MAX_UNITS_PER_DEVELOPMENT`), one statement. */
export async function unitsOfDevelopments(
  tx: Tx,
  agencyId: string,
  developmentIds: readonly string[],
): Promise<UnitListRow[]> {
  if (developmentIds.length === 0) return [];
  // The agency too: units are NETWORK_READ, a shared development's id must not bring another agency's units.
  return tx
    .select(unitListColumns)
    .from(units)
    .where(and(eq(units.agencyId, agencyId), sql`${units.developmentId} = any(${array(developmentIds, 'uuid')})`));
}

/** What a feed owns of a unit: set together for every unit it changed (S7-F14). */
export interface FeedUnitValues {
  id: string;
  developmentId: string;
  propertyTypeId: string;
  bedrooms: number | null;
  bathrooms: number | null;
  internalM2: number | null;
  terraceM2: number | null;
  priceCents: number | null;
  status: UnitRow['status'];
}

/** A unit a feed creates: its feed-owned columns, a reference and the development's currency. */
export interface FeedUnitInsert extends FeedUnitValues {
  ref: string;
  currency: string;
}

const feedUnitColumns = (values: readonly FeedUnitValues[]) => {
  const col = <K extends keyof FeedUnitValues>(k: K, type: string) =>
    array(
      values.map((r) => r[k]),
      type,
    );
  return sql`${col('id', 'uuid')}, ${col('developmentId', 'uuid')}, ${col('propertyTypeId', 'uuid')}, ${col('bedrooms', 'integer')}, ${col('bathrooms', 'integer')}, ${col('internalM2', 'numeric')}, ${col('terraceM2', 'numeric')}, ${col('priceCents', 'bigint')}, ${col('status', 'unit_status')}`;
};
const FEED_UNIT_NAMES = sql.raw(
  'id, development_id, property_type_id, bedrooms, bathrooms, internal_m2, terrace_m2, price_cents, status',
);

/**
 * Many units of many developments of one agency, one statement whatever the count (one parameter per column).
 * Returns how many were written; the caller has their values.
 */
export async function insertFeedUnits(tx: Tx, agencyId: string, values: readonly FeedUnitInsert[]): Promise<number> {
  if (values.length === 0) return 0;
  const result = await tx.execute(sql`insert into ${units}
      (id, development_id, agency_id, ref, property_type_id, bedrooms, bathrooms, internal_m2, terrace_m2, price_cents,
       status, currency, from_feed)
    select v.id, v.development_id, ${agencyId}::uuid, v.ref, v.property_type_id, v.bedrooms, v.bathrooms, v.internal_m2,
           v.terrace_m2, v.price_cents, v.status, v.currency, true
      from unnest(${feedUnitColumns(values)}, ${array(
        values.map((r) => r.ref),
        'text',
      )}, ${array(
        values.map((r) => r.currency),
        'text',
      )}) as v(${FEED_UNIT_NAMES}, ref, currency)`);
  return result.rowCount ?? values.length;
}

/** The feed-owned columns of many units of many developments, one statement (one bind parameter per column). */
export async function setFeedUnits(tx: Tx, agencyId: string, values: readonly FeedUnitValues[]): Promise<UnitRow[]> {
  if (values.length === 0) return [];
  const v = sql`v`;
  return tx
    .update(units)
    .set({
      propertyTypeId: sql`${v}.property_type_id`,
      bedrooms: sql`${v}.bedrooms`,
      bathrooms: sql`${v}.bathrooms`,
      internalM2: sql`${v}.internal_m2`,
      terraceM2: sql`${v}.terrace_m2`,
      priceCents: sql`${v}.price_cents`,
      status: sql`${v}.status`,
      version: sql`${units.version} + 1`,
      updatedAt: sql`now()`,
    })
    .from(sql`unnest(${feedUnitColumns(values)}) as v(${FEED_UNIT_NAMES})`)
    .where(
      and(
        eq(units.agencyId, agencyId),
        // The developments too (as `setUnitPrices`): keeps the plan on `units_development_ref_uq` under RLS.
        sql`${units.developmentId} = any(${array([...new Set(values.map((r) => r.developmentId))], 'uuid')})`,
        sql`${units.id} = ${v}.id`,
        sql`${units.developmentId} = ${v}.development_id`,
      ),
    )
    .returning();
}

/** Feed units its price list no longer names (S8-F3), with their history (cascade), one statement. Returns the ids removed. */
export async function withdrawFeedUnits(
  tx: Tx,
  agencyId: string,
  developmentIds: readonly string[],
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  // Only what the feed created and nobody reserved or bought: a hand unit, a RESERVED or SOLD one is never removed.
  const rows = await tx
    .delete(units)
    .where(
      and(
        eq(units.agencyId, agencyId),
        sql`${units.developmentId} = any(${array(developmentIds, 'uuid')})`,
        sql`${units.id} = any(${array(ids, 'uuid')})`,
        eq(units.fromFeed, true),
        eq(units.status, 'AVAILABLE'),
      ),
    )
    .returning({ id: units.id });
  return rows.map((r) => r.id);
}
