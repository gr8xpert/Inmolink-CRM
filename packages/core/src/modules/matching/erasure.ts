import { withSystem } from '@inmolink/db';
import { savedSearchAlerts, savedSearches } from '@inmolink/db/schema/matching';
import { eq, sql } from 'drizzle-orm';

/** Saved searches per statement. */
const BATCH = 500;

/**
 * Agency erasure, the matching side (S16-04 review): the agency's members' saved searches (a free-text name — often a
 * client's — and the client's wishes) and their alerts, a batch at a time. Worker-only (`app_system`). `more`: call
 * again. Idempotent.
 */
export async function deleteAgencySavedSearches(p: { agencyId: string }): Promise<{ rows: number; more: boolean }> {
  return withSystem('matching.deleteAgencySavedSearches', async (tx) => {
    const res = await tx.execute(sql`
      select id from ${savedSearches} where agency_id = ${p.agencyId} limit ${BATCH}`);
    const ids = (res.rows as { id: string }[]).map((r) => r.id);
    if (ids.length === 0) {
      await tx.delete(savedSearchAlerts).where(eq(savedSearchAlerts.agencyId, p.agencyId));
      return { rows: 0, more: false };
    }
    const list = sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    await tx.execute(
      sql`delete from ${savedSearchAlerts} where agency_id = ${p.agencyId} and saved_search_id in (${list})`,
    );
    await tx.execute(sql`delete from ${savedSearches} where agency_id = ${p.agencyId} and id in (${list})`);
    return { rows: ids.length, more: ids.length === BATCH };
  });
}
