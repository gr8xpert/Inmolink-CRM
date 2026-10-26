/**
 * Legacy contact and lead load queries (S14-02): crm tables only, a fixed number of statements per batch (multi-row
 * inserts, one array parameter per column for lookups). Runs in the load script's `withSystem()` transaction.
 */
import type { Tx } from '@inmolink/db';
import { contacts, leads } from '@inmolink/db/schema/crm';
import { sql } from 'drizzle-orm';

const array = (values: readonly unknown[], type: string) => sql`${sql.param(values)}::${sql.raw(type)}[]`;

/** These contacts of the agency as they stand: a merged one names its survivor. One statement (PK). */
export async function contactStates(
  tx: Tx,
  agencyId: string,
  ids: readonly string[],
): Promise<{ id: string; mergedIntoId: string | null; deleted: boolean }[]> {
  if (ids.length === 0) return [];
  const res = await tx.execute(sql`
    select id, merged_into_id as "mergedIntoId", deleted_at is not null as deleted from ${contacts}
     where agency_id = ${agencyId} and id = any(${array(ids, 'uuid')})`);
  return res.rows as { id: string; mergedIntoId: string | null; deleted: boolean }[];
}

export type LegacyContactInsert = Omit<typeof contacts.$inferInsert, 'version' | 'updatedAt' | 'deletedAt'> & {
  id: string;
  createdAt: Date;
};

/** New contacts with their legacy creation time, one statement. */
export async function insertLegacyContacts(tx: Tx, rows: readonly LegacyContactInsert[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(contacts).values(rows.map((r) => ({ ...r, updatedAt: r.createdAt })));
}

/** Which of these leads the agency has (an earlier run created them). One statement (PK). */
export async function existingLeads(tx: Tx, agencyId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const res = await tx.execute(sql`
    select id from ${leads} where agency_id = ${agencyId} and id = any(${array(ids, 'uuid')})`);
  return new Set((res.rows as { id: string }[]).map((r) => r.id));
}

export type LegacyLeadInsert = typeof leads.$inferInsert & { id: string; createdAt: Date };

/** New leads with their legacy creation time, one statement (the stage history trigger records their first stage). */
export async function insertLegacyLeads(tx: Tx, rows: readonly LegacyLeadInsert[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(leads).values(rows.map((r) => ({ ...r, updatedAt: r.createdAt })));
}
