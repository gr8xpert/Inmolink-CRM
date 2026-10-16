/**
 * developments queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/developments` — other modules' tables fail `pnpm check:boundaries`.
 */
import type { Tx } from '@inmolink/db';
import {
  developmentAccess,
  developments,
  priceLists,
  unitPriceHistories,
  unitStatusHistories,
  units,
} from '@inmolink/db/schema/developments';
import { and, asc, count, desc, eq, getTableColumns, gt, inArray, isNull, lt, type SQL, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfter, keysetOrder } from '../../pagination';

export type DevelopmentRow = typeof developments.$inferSelect;
export type DevelopmentInsert = typeof developments.$inferInsert;
export type UnitRow = typeof units.$inferSelect;
export type UnitInsert = typeof units.$inferInsert;
export type PriceListRow = typeof priceLists.$inferSelect;

// ── Developments ─────────────────────────────────────────────────────────────────────────────────────────────

export async function insertDevelopment(tx: Tx, row: DevelopmentInsert): Promise<DevelopmentRow> {
  const [inserted] = await tx.insert(developments).values(row).returning();
  return inserted as DevelopmentRow;
}

/** A development the caller can read (own or shared through RLS), not deleted. */
export async function getDevelopment(tx: Tx, id: string): Promise<DevelopmentRow | null> {
  const [row] = await tx
    .select()
    .from(developments)
    .where(and(eq(developments.id, id), isNull(developments.deletedAt)));
  return row ?? null;
}

/** The agency's own, not deleted development, row-locked: changes of one development run one after another. */
export async function getOwnForUpdate(tx: Tx, agencyId: string, id: string): Promise<DevelopmentRow | null> {
  const [row] = await tx
    .select()
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
    .returning();
  return row ?? null; // null → version conflict
}

/** The agency's developments, newest first (`developments_agency_created_idx`). */
export async function listOwnDevelopments(
  tx: Tx,
  agencyId: string,
  q: { limit: number; cursor?: KeysetCursor },
): Promise<{ items: DevelopmentRow[]; hasMore: boolean }> {
  const rows = await tx
    .select()
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
): Promise<{ items: UnitRow[]; hasMore: boolean }> {
  const rows = await tx
    .select()
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

/** Every unit of a development (at most `MAX_UNITS_PER_DEVELOPMENT`), locked for a price list apply. */
export async function allUnitsForUpdate(tx: Tx, developmentId: string): Promise<UnitRow[]> {
  return tx.select().from(units).where(eq(units.developmentId, developmentId)).orderBy(asc(units.ref)).for('update');
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

/** Units of the development by id, row-locked (one statement). */
export async function unitsForUpdate(tx: Tx, developmentId: string, ids: readonly string[]): Promise<UnitRow[]> {
  return tx
    .select()
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

/** A price and status per unit (a price list apply), one statement. */
export async function setUnitPrices(
  tx: Tx,
  values: readonly { id: string; priceCents: number | null; status: UnitRow['status'] }[],
): Promise<UnitRow[]> {
  if (values.length === 0) return [];
  const rows = sql.join(
    values.map((v) => sql`(${v.id}::uuid, ${v.priceCents}::bigint, ${v.status}::unit_status)`),
    sql`, `,
  );
  const v = sql`v`;
  return tx
    .update(units)
    .set({
      priceCents: sql`${v}.price_cents`,
      status: sql`${v}.status`,
      version: sql`${units.version} + 1`,
      updatedAt: sql`now()`,
    })
    .from(sql`(values ${rows}) as v(id, price_cents, status)`)
    .where(sql`${units.id} = ${v}.id`)
    .returning();
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
  const [inserted] = await tx.insert(priceLists).values(row).returning();
  return inserted as PriceListRow;
}

export async function getPriceList(tx: Tx, developmentId: string, version: number): Promise<PriceListRow | null> {
  const [row] = await tx
    .select()
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
    .returning();
  return row as PriceListRow;
}

/** The development's versions, latest first (`price_lists_development_version_uq`). */
export async function listPriceLists(
  tx: Tx,
  developmentId: string,
  q: { limit: number; beforeVersion?: number },
): Promise<{ items: Omit<PriceListRow, 'entries'>[]; hasMore: boolean }> {
  const where: (SQL | undefined)[] = [
    eq(priceLists.developmentId, developmentId),
    q.beforeVersion === undefined ? undefined : lt(priceLists.version, q.beforeVersion),
  ];
  const { entries: _entries, ...listColumns } = getTableColumns(priceLists); // entries: up to 2,000 lines each
  const rows = await tx
    .select(listColumns)
    .from(priceLists)
    .where(and(...where))
    .orderBy(desc(priceLists.version))
    .limit(q.limit + 1);
  return { items: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
}
