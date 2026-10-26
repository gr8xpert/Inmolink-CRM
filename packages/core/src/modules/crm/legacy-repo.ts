/**
 * Legacy contact and lead load queries (S14-02): crm tables only, a fixed number of statements per batch (multi-row
 * inserts, one array parameter per column for lookups). Runs in the load script's `withSystem()` transaction.
 */
import type { Tx } from '@inmolink/db';
import { contactEmails, contactPhones, contacts, leads } from '@inmolink/db/schema/crm';
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

/** S14-03: what a validation compares of a migrated contact. */
export interface LegacyContactSnapshot {
  id: string;
  firstName: string | null;
  lastName: string | null;
  language: string | null;
  source: string;
  /** Merged into another contact (`deleted` too) or deleted. */
  mergedIntoId: string | null;
  deleted: boolean;
  emails: string[];
  phones: string[];
}

/** These contacts of the agency with their e-mails and phones (S14-03 validation sample). One statement (PK). */
export async function contactSnapshots(
  tx: Tx,
  agencyId: string,
  ids: readonly string[],
): Promise<LegacyContactSnapshot[]> {
  if (ids.length === 0) return [];
  const res = await tx.execute(sql`
    select c.id, c.first_name as "firstName", c.last_name as "lastName", c.language, c.source,
           c.merged_into_id as "mergedIntoId", c.deleted_at is not null as deleted,
           coalesce((select array_agg(e.email order by e.position) from ${contactEmails} e
                      where e.agency_id = c.agency_id and e.contact_id = c.id), '{}') as emails,
           coalesce((select array_agg(p.phone order by p.position) from ${contactPhones} p
                      where p.agency_id = c.agency_id and p.contact_id = c.id), '{}') as phones
      from ${contacts} c
     where c.agency_id = ${agencyId} and c.id = any(${array(ids, 'uuid')})`);
  return res.rows as unknown as LegacyContactSnapshot[];
}

/** S14-03: what a validation compares of a migrated lead. */
export interface LegacyLeadSnapshot {
  id: string;
  contactId: string;
  status: string;
  source: string;
  targetKind: string | null;
  targetId: string | null;
}

/** These leads of the agency (S14-03 validation sample). One statement (PK). */
export async function leadSnapshots(tx: Tx, agencyId: string, ids: readonly string[]): Promise<LegacyLeadSnapshot[]> {
  if (ids.length === 0) return [];
  const res = await tx.execute(sql`
    select id, contact_id as "contactId", status, source, target_kind as "targetKind", target_id as "targetId"
      from ${leads} where agency_id = ${agencyId} and id = any(${array(ids, 'uuid')})`);
  return res.rows as unknown as LegacyLeadSnapshot[];
}
