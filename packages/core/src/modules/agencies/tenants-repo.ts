import type { Tx } from '@inmolink/db';
import { agencies } from '@inmolink/db/schema/agencies';
import { and, eq, ilike, or, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfter, keysetOrder } from '../../pagination';

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
 * Newest agencies first, keyset on `(created_at, agency_id)` (`agencies_created_idx`, scanned backwards).
 * `q`: a name substring (case-insensitive) or the exact, normalized tax id. A few thousand agencies: the
 * name filter is applied during the index scan; add `pg_trgm` beyond that.
 */
export async function listTenants(
  tx: Tx,
  q: { limit: number; cursor?: KeysetCursor; status?: AgencyStatus; search?: string },
): Promise<TenantRow[]> {
  const { cursor, search } = q;
  const taxId = search?.toUpperCase().replace(/[\s.-]/g, '');
  return tx
    .select(summaryColumns)
    .from(agencies)
    .where(
      and(
        q.status ? eq(agencies.status, q.status) : undefined,
        search ? or(ilike(agencies.name, `%${likeEscape(search)}%`), eq(agencies.taxId, taxId ?? '')) : undefined,
        keysetAfter(agencies.createdAt, agencies.id, cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrder(agencies.createdAt, agencies.id, 'desc'))
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
      version: agencies.version,
      updatedAt: agencies.updatedAt,
    })
    .from(agencies)
    .where(eq(agencies.id, id));
  return row ?? null;
}
