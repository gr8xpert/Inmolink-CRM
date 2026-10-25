import type { Tx } from '@inmolink/db';
import { agencies } from '@inmolink/db/schema/agencies';
import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfterRaw, keysetOrderRaw, keysetStamp } from '../../pagination';

/**
 * Staff console tenant queries (S1-09, PATTERNS §5), as `app_staff` (registry `staff.select = 'true'`
 * on `agencies`). Kept apart from `repo.ts` (size).
 */

export type AgencyStatus = (typeof agencies.$inferSelect)['status'];

const summaryColumns = {
  id: agencies.id,
  name: agencies.name,
  kind: agencies.kind,
  status: agencies.status,
  taxId: agencies.taxId,
  createdAt: agencies.createdAt,
};

export type TenantRow = {
  id: string;
  name: string;
  kind: (typeof agencies.$inferSelect)['kind'];
  status: AgencyStatus;
  taxId: string | null;
  createdAt: Date;
};

/** `%`, `_` and `\` are literal in the staff search box. */
function likeEscape(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Newest agencies first, raw keyset on `(created_at, agency_id)` (`agencies_created_raw_idx`, scanned backwards).
 * `q`: a name substring (case-insensitive) or the exact, normalized tax id. A few thousand agencies: the
 * name filter uses `agencies_name_trgm_idx` (pg_trgm GIN, S1-F9; two characters or more).
 */
export async function listTenants(
  tx: Tx,
  q: { limit: number; cursor?: KeysetCursor; status?: AgencyStatus; search?: string },
): Promise<(TenantRow & { atUs: string })[]> {
  const { cursor, search } = q;
  const taxId = search?.toUpperCase().replace(/[\s.-]/g, '');
  return tx
    .select({ ...summaryColumns, atUs: keysetStamp(agencies.createdAt) })
    .from(agencies)
    .where(
      and(
        q.status ? eq(agencies.status, q.status) : undefined,
        search ? or(ilike(agencies.name, `%${likeEscape(search)}%`), eq(agencies.taxId, taxId ?? '')) : undefined,
        keysetAfterRaw(agencies.createdAt, agencies.id, cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrderRaw(agencies.createdAt, agencies.id, 'desc'))
    .limit(q.limit + 1);
}

/** One agency's company details for the tenant page. */
export async function getTenant(tx: Tx, id: string) {
  const [row] = await tx
    .select({
      ...summaryColumns,
      registerNumber: agencies.registerNumber,
      city: agencies.city,
      region: agencies.region,
      onboarded: sql<boolean>`${agencies.onboardedAt} is not null`,
      giveToGetExempt: agencies.giveToGetExempt,
      giveToGetReason: agencies.giveToGetReason,
      version: agencies.version,
      updatedAt: agencies.updatedAt,
    })
    .from(agencies)
    .where(eq(agencies.id, id));
  return row ?? null;
}

/**
 * Staff set or end an agency's give-to-get exemption with their reason (S5-05, S6-F1); the guard (migration 0077) lets
 * staff change only these and the status. The version is left alone: it versions the company details staff verify.
 * Answers the exemption before the change (the row locked first, so two staff members' changes record a true
 * before), or null: no such agency.
 */
export async function setGiveToGetExempt(
  tx: Tx,
  id: string,
  change: { exempt: boolean; reason: string },
  now: Date,
): Promise<{ before: boolean } | null> {
  const [current] = await tx
    .select({ exempt: agencies.giveToGetExempt })
    .from(agencies)
    .where(eq(agencies.id, id))
    .for('no key update');
  if (!current) return null;
  await tx
    .update(agencies)
    .set({ giveToGetExempt: change.exempt, giveToGetReason: change.reason, updatedAt: now })
    .where(eq(agencies.id, id));
  return { before: current.exempt };
}

/** Names for a page of ids in one query (the staff audit viewer): unknown ids are simply absent. */
export async function agencyNames(tx: Tx, ids: readonly string[]): Promise<{ id: string; name: string }[]> {
  if (ids.length === 0) return [];
  return tx
    .select({ id: agencies.id, name: agencies.name })
    .from(agencies)
    .where(inArray(agencies.id, [...ids]));
}

/** S13-03: a page of agency ids in id order after `after` (staff bulk operations walk every agency). Primary key walk. */
export async function agencyIdsPage(tx: Tx, after: string | null, limit: number): Promise<string[]> {
  const rows = await tx
    .select({ id: agencies.id })
    .from(agencies)
    .where(after ? sql`${agencies.id} > ${after}::uuid` : undefined)
    .orderBy(agencies.id)
    .limit(limit);
  return rows.map((r) => r.id);
}

/** S13-03: how many agencies there are (a bulk operation's total). */
export async function countAgencies(tx: Tx): Promise<number> {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(agencies);
  return row?.n ?? 0;
}
