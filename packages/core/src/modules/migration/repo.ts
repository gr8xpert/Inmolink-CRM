/**
 * migration queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/migration` — other modules' tables fail `pnpm check:boundaries`.
 */
import type { Tx } from '@inmolink/db';
import { legacyIdMaps } from '@inmolink/db/schema/migration';
import { and, eq, inArray, sql } from 'drizzle-orm';

export type MapEntity = 'location' | 'propertyType' | 'feature';
export type IdMapRow = { id: string; legacyId: string; newId: string; method: string };

/** Current maps of the given legacy IDs of one entity (one statement per chunk). */
export async function getMaps(tx: Tx, entity: MapEntity, legacyIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < legacyIds.length; i += 1000) {
    const rows = await tx
      .select({ legacyId: legacyIdMaps.legacyId, newId: legacyIdMaps.newId })
      .from(legacyIdMaps)
      .where(and(eq(legacyIdMaps.entity, entity), inArray(legacyIdMaps.legacyId, legacyIds.slice(i, i + 1000))));
    for (const r of rows) out.set(r.legacyId, r.newId);
  }
  return out;
}

/** Idempotent: a re-run with the same pair changes nothing visible; a moved target is replaced. */
export async function upsertMaps(tx: Tx, entity: MapEntity, rows: readonly IdMapRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 1000) {
    await tx
      .insert(legacyIdMaps)
      .values(rows.slice(i, i + 1000).map((r) => ({ ...r, entity })))
      .onConflictDoUpdate({
        target: [legacyIdMaps.entity, legacyIdMaps.legacyId],
        set: { newId: sql`excluded.new_id`, method: sql`excluded.method`, updatedAt: sql`now()` },
      });
  }
}
