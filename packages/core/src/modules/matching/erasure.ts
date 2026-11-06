import { withSystem } from '@inmolink/db';
import {
  clientProfileEmbeddings,
  clientProfiles,
  savedSearchAlerts,
  savedSearches,
} from '@inmolink/db/schema/matching';
import { and, eq, inArray, sql } from 'drizzle-orm';

/** Saved searches per statement. */
const BATCH = 500;

/**
 * Agency erasure, the matching side (S16-04 review): the agency's members' saved searches (a free-text name — often a
 * client's — and the client's wishes) and their alerts, a batch at a time. Worker-only (`app_system`). `more`: call
 * again. Idempotent. R2-01b: first its client profiles (criteria and wishes: client data) and their vectors, then
 * vectors an embed job wrote after their profile went. A job landing after this step has moved on can still leave a
 * vector (numbers only, no text): the next daily profile backfill drops it as an orphan.
 */
export async function deleteAgencySavedSearches(p: { agencyId: string }): Promise<{ rows: number; more: boolean }> {
  return withSystem('matching.deleteAgencySavedSearches', async (tx) => {
    const profiles = await tx.execute(sql`
      delete from ${clientProfiles} where agency_id = ${p.agencyId}
         and id in (select id from ${clientProfiles} where agency_id = ${p.agencyId} limit ${BATCH})
      returning id`);
    const profileIds = (profiles.rows as { id: string }[]).map((r) => r.id);
    if (profileIds.length > 0) {
      await tx
        .delete(clientProfileEmbeddings)
        .where(
          and(
            eq(clientProfileEmbeddings.ownerAgencyId, p.agencyId),
            inArray(clientProfileEmbeddings.profileId, profileIds),
          ),
        );
      return { rows: profileIds.length, more: true };
    }
    // vectors written after their profile was deleted (an embed job racing the erasure), a batch at a time
    const strays = await tx.execute(sql`
      delete from ${clientProfileEmbeddings} where owner_agency_id = ${p.agencyId}
         and profile_id in (select profile_id from ${clientProfileEmbeddings}
                             where owner_agency_id = ${p.agencyId} limit ${BATCH})`);
    if ((strays.rowCount ?? 0) > 0) return { rows: strays.rowCount ?? 0, more: true };
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
