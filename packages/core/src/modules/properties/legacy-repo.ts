/**
 * Legacy listing queries (S14-02): properties tables only, one statement per batch whatever its size (one bind parameter
 * per column). Runs in the load script's `withSystem()` transaction.
 */
import type { Tx } from '@inmolink/db';
import { properties } from '@inmolink/db/schema/properties';
import { sql } from 'drizzle-orm';

const array = (values: readonly unknown[], type: string) => sql`${sql.param(values)}::${sql.raw(type)}[]`;

/** New migrated listings: their legacy agent as owner and their legacy id. */
export async function setLegacyOrigin(
  tx: Tx,
  agencyId: string,
  rows: readonly { id: string; legacyId: string; ownerUserId: string }[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx.execute(sql`
    update ${properties} p set owner_user_id = v.owner_user_id, legacy_id = v.legacy_id
      from unnest(${array(
        rows.map((r) => r.id),
        'uuid',
      )}, ${array(
        rows.map((r) => r.legacyId),
        'text',
      )}, ${array(
        rows.map((r) => r.ownerUserId),
        'uuid',
      )}) as v(id, legacy_id, owner_user_id)
     where p.agency_id = ${agencyId} and p.id = v.id`);
}
