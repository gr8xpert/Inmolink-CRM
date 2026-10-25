/**
 * websites queries (PATTERNS §5). Runs as `app_user` under `withTenant` (dashboard) and as `app_public` under
 * `withPublicRead` (feed-api: a key's site). Queries only `@inmolink/db/schema/websites`.
 */
import type { Tx } from '@inmolink/db';
import { websiteSites } from '@inmolink/db/schema/websites';
import { and, asc, count, eq, gt, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfterRaw, keysetOrderRaw, keysetStamp } from '../../pagination';

export type WebsiteMode = (typeof websiteSites.$inferSelect)['mode'];
export type InventoryPolicy = (typeof websiteSites.$inferSelect)['inventoryPolicy'];

const siteColumns = {
  atUs: keysetStamp(websiteSites.createdAt),
  id: websiteSites.id,
  agencyId: websiteSites.agencyId,
  name: websiteSites.name,
  domains: websiteSites.domains,
  mode: websiteSites.mode,
  inventoryPolicy: websiteSites.inventoryPolicy,
  inventoryFilters: websiteSites.inventoryFilters,
  referencePrefix: websiteSites.referencePrefix,
  locales: websiteSites.locales,
  defaultLocale: websiteSites.defaultLocale,
  contact: websiteSites.contact,
  version: websiteSites.version,
  createdAt: websiteSites.createdAt,
  updatedAt: websiteSites.updatedAt,
};

export interface SiteRow {
  /** `keysetStamp` of the sort time: the exact cursor of the list. */
  atUs: string;
  id: string;
  agencyId: string;
  name: string;
  domains: string[];
  mode: WebsiteMode;
  inventoryPolicy: InventoryPolicy;
  inventoryFilters: unknown;
  referencePrefix: string | null;
  locales: string[];
  defaultLocale: string;
  contact: unknown;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** The fields a site's setup consists of (insert and update). */
export interface SiteFields {
  name: string;
  domains: string[];
  mode: WebsiteMode;
  inventoryPolicy: InventoryPolicy;
  inventoryFilters: unknown;
  referencePrefix: string | null;
  locales: string[];
  defaultLocale: string;
  contact: unknown;
}

export async function insertSite(
  tx: Tx,
  row: SiteFields & { id: string; agencyId: string; createdBy: string; createdAt: Date },
): Promise<SiteRow> {
  const [inserted] = await tx
    .insert(websiteSites)
    .values({ ...row, updatedAt: row.createdAt })
    .returning(siteColumns);
  if (!inserted) throw new Error('insertSite: no row returned');
  return inserted;
}

/** The agency's sites (the cap). Uses `website_sites_agency_created_idx`; a few rows. */
export async function countSites(tx: Tx, agencyId: string): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(websiteSites).where(eq(websiteSites.agencyId, agencyId));
  return row?.n ?? 0;
}

/** The agency's sites, oldest first (keyset on `(created_at, id)`). */
export async function listSites(
  tx: Tx,
  agencyId: string,
  q: { limit: number; cursor?: KeysetCursor },
): Promise<SiteRow[]> {
  return await sitesPageQuery(tx, agencyId, q);
}

/** The statement of `listSites`, not yet run (the EXPLAIN test runs the repo's own query). */
export function sitesPageQuery(tx: Tx, agencyId: string, q: { limit: number; cursor?: KeysetCursor }) {
  return tx
    .select(siteColumns)
    .from(websiteSites)
    .where(
      and(
        eq(websiteSites.agencyId, agencyId),
        keysetAfterRaw(websiteSites.createdAt, websiteSites.id, q.cursor, 'asc'),
      ),
    )
    .orderBy(...keysetOrderRaw(websiteSites.createdAt, websiteSites.id, 'asc'))
    .limit(q.limit + 1);
}

/** One site of the agency; `forUpdate` locks it for an edit. */
export async function getSite(tx: Tx, agencyId: string, id: string, forUpdate = false): Promise<SiteRow | null> {
  const query = tx
    .select(siteColumns)
    .from(websiteSites)
    .where(and(eq(websiteSites.agencyId, agencyId), eq(websiteSites.id, id)));
  const [row] = await (forUpdate ? query.for('update') : query);
  return row ?? null;
}

/** The agency's oldest site (a key created without a site is bound to it). */
export async function firstSiteId(tx: Tx, agencyId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: websiteSites.id })
    .from(websiteSites)
    .where(eq(websiteSites.agencyId, agencyId))
    .orderBy(...keysetOrderRaw(websiteSites.createdAt, websiteSites.id, 'asc'))
    .limit(1);
  return row?.id ?? null;
}

/** Writes a locked site's new setup and bumps its version. */
export async function updateSite(
  tx: Tx,
  agencyId: string,
  id: string,
  fields: SiteFields,
  now: Date,
): Promise<SiteRow> {
  const [row] = await tx
    .update(websiteSites)
    .set({ ...fields, version: sql`${websiteSites.version} + 1`, updatedAt: now })
    .where(and(eq(websiteSites.agencyId, agencyId), eq(websiteSites.id, id)))
    .returning(siteColumns);
  if (!row) throw new Error('updateSite: no row returned');
  return row;
}

/** What the website API needs of a site (cached as JSON: dates as ISO strings). */
export type SiteScopeRow = Omit<SiteRow, 'createdAt' | 'updatedAt'> & {
  /** S13-F21: the agency's plan in force as last synced (null: not yet). */
  planCode: string | null;
  /** S13-F21: when the website API stops serving the site (ISO; null: it serves). */
  planEndsAt: string | null;
};

/** feed-api (`app_public`): a site by id, PK probe. */
export async function findSite(tx: Tx, id: string): Promise<SiteScopeRow | null> {
  const { createdAt: _c, updatedAt: _u, ...columns } = siteColumns;
  const [row] = await tx
    .select({ ...columns, planCode: websiteSites.planCode, planEndsAt: websiteSites.planEndsAt })
    .from(websiteSites)
    .where(eq(websiteSites.id, id))
    .limit(1);
  return row ? { ...row, planEndsAt: row.planEndsAt?.toISOString() ?? null } : null;
}

/**
 * S13-F21 (worker, `app_system`): records the agency's plan on its sites and when their website API stops serving
 * (`endsAt` when the plan lost `website_api`: an earlier cut-off already set is kept, so a re-sync never extends the
 * notice; null: it serves). Returns the ids of the sites that changed (their cached scope is dropped). Uses
 * `website_sites_agency_id_uq`; a few rows.
 */
export async function setSitePlan(
  tx: Tx,
  agencyId: string,
  planCode: string,
  endsAt: Date | null,
): Promise<{ id: string; planEndsAt: Date | null }[]> {
  const next = endsAt
    ? sql`coalesce(${websiteSites.planEndsAt}, ${endsAt.toISOString()}::timestamptz)`
    : sql`null::timestamptz`;
  const rows = await tx
    .update(websiteSites)
    .set({ planCode, planEndsAt: next })
    .where(
      and(
        eq(websiteSites.agencyId, agencyId),
        sql`(${websiteSites.planCode}, ${websiteSites.planEndsAt}) is distinct from (${planCode}::text, ${next})`,
      ),
    )
    .returning({ id: websiteSites.id, planEndsAt: websiteSites.planEndsAt });
  return rows;
}

/** S13-F21 (worker sweep): agencies with at least one site, after `after` in id order (keyset; the agency index). */
export async function agenciesWithSites(tx: Tx, after: string | null, limit: number): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ agencyId: websiteSites.agencyId })
    .from(websiteSites)
    .where(after ? gt(websiteSites.agencyId, after) : undefined)
    .orderBy(asc(websiteSites.agencyId))
    .limit(limit);
  return rows.map((r) => r.agencyId);
}
