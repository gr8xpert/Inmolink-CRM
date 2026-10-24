/**
 * Portal selection queries (S9-01). `tx` of a request (`app_user`, `withTenant`) or a worker (`withSystem`); always
 * pinned to one agency explicitly (NETWORK_READ would otherwise show other agencies' PUBLIC rows too). Ids only, in
 * id order, keyset-paged: `properties_agency_export_idx` and `property_tags_agency_tag_idx` serve the page reads.
 */
import type { Tx } from '@inmolink/db';
import { properties, propertyTags } from '@inmolink/db/schema/properties';
import { and, asc, eq, gt, inArray, isNull, type SQL, sql } from 'drizzle-orm';

/** A listing a portal may carry: live, PUBLIC, not deleted. The partial index's predicate. */
const exportable = (): SQL[] => [
  eq(properties.status, 'ACTIVE'),
  eq(properties.visibility, 'PUBLIC'),
  isNull(properties.deletedAt),
];

/**
 * The agency's exportable listings after `after`, in id order, at most `limit`; with `tag`, those carrying it.
 * One statement (an index range scan on the agency's partial index, or the tag index joined by primary key).
 */
export async function exportableIdPage(
  tx: Tx,
  agencyId: string,
  q: { tag: string | null; after: string | null; limit: number },
): Promise<string[]> {
  if (q.tag === null) {
    const rows = await tx
      .select({ id: properties.id })
      .from(properties)
      .where(and(eq(properties.agencyId, agencyId), ...exportable(), q.after ? gt(properties.id, q.after) : undefined))
      .orderBy(asc(properties.id))
      .limit(q.limit);
    return rows.map((r) => r.id);
  }
  const rows = await tx
    .select({ id: propertyTags.propertyId })
    .from(propertyTags)
    .innerJoin(
      properties,
      and(eq(properties.id, propertyTags.propertyId), eq(properties.agencyId, propertyTags.agencyId)),
    )
    .where(
      and(
        eq(propertyTags.agencyId, agencyId),
        eq(propertyTags.tag, q.tag),
        ...exportable(),
        q.after ? gt(propertyTags.propertyId, q.after) : undefined,
      ),
    )
    .orderBy(asc(propertyTags.propertyId))
    .limit(q.limit);
  return rows.map((r) => r.id);
}

/**
 * `exportableIdPage` and `exportableIds` in one statement (S10-F9, a portal pass's grouped selection): the page after
 * `after` (optionally of a tag) and, of `ids` (a page's worth of INCLUDEs), the exportable ones. Same indexes.
 */
export async function exportableIdPageWith(
  tx: Tx,
  agencyId: string,
  q: { tag: string | null; after: string | null; limit: number },
  ids: readonly string[],
): Promise<{ page: string[]; eligible: string[] }> {
  if (ids.length === 0) return { page: await exportableIdPage(tx, agencyId, q), eligible: [] };
  const page =
    q.tag === null
      ? tx
          .select({ id: properties.id, page: sql<boolean>`true`.as('page') })
          .from(properties)
          .where(
            and(eq(properties.agencyId, agencyId), ...exportable(), q.after ? gt(properties.id, q.after) : undefined),
          )
          .orderBy(asc(properties.id))
          .limit(q.limit)
      : tx
          .select({ id: sql<string>`${propertyTags.propertyId}`.as('id'), page: sql<boolean>`true`.as('page') })
          .from(propertyTags)
          .innerJoin(
            properties,
            and(eq(properties.id, propertyTags.propertyId), eq(properties.agencyId, propertyTags.agencyId)),
          )
          .where(
            and(
              eq(propertyTags.agencyId, agencyId),
              eq(propertyTags.tag, q.tag),
              ...exportable(),
              q.after ? gt(propertyTags.propertyId, q.after) : undefined,
            ),
          )
          .orderBy(asc(propertyTags.propertyId))
          .limit(q.limit);
  const among = tx
    .select({ id: properties.id, page: sql<boolean>`false`.as('page') })
    .from(properties)
    .where(and(eq(properties.agencyId, agencyId), inArray(properties.id, [...ids]), ...exportable()));
  const res = await tx.execute<{ id: string; page: boolean }>(sql`(${page}) union all (${among})`);
  const out = { page: [] as string[], eligible: [] as string[] };
  for (const r of res.rows) (r.page ? out.page : out.eligible).push(r.id);
  out.page.sort();
  return out;
}

/** Of these ids (at most a page), the agency's exportable listings. Primary-key probes. */
export async function exportableIds(tx: Tx, agencyId: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.agencyId, agencyId), inArray(properties.id, [...ids]), ...exportable()));
  return rows.map((r) => r.id);
}

/** Of these ids, the agency's own listings that are not deleted (any status, any visibility). */
export async function ownLiveIds(tx: Tx, agencyId: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.agencyId, agencyId), inArray(properties.id, [...ids]), isNull(properties.deletedAt)));
  return rows.map((r) => r.id);
}

/** References of these listings (the dashboard shows refs, not ids). */
export async function refsOf(tx: Tx, agencyId: string, ids: readonly string[]): Promise<{ id: string; ref: string }[]> {
  if (ids.length === 0) return [];
  return tx
    .select({ id: properties.id, ref: properties.ref })
    .from(properties)
    .where(and(eq(properties.agencyId, agencyId), inArray(properties.id, [...ids])));
}

/**
 * The agency's not deleted listings with these references (compared as `upper(ref)`, the stored `ref_key`, in the C
 * collation like the list's prefix filter): one statement on `properties_agency_ref_key_idx`.
 */
export async function idsByRefs(
  tx: Tx,
  agencyId: string,
  refs: readonly string[],
): Promise<{ id: string; ref: string }[]> {
  if (refs.length === 0) return [];
  const keys = refs.map((r) => r.toUpperCase());
  return tx
    .select({ id: properties.id, ref: properties.ref })
    .from(properties)
    .where(
      and(
        eq(properties.agencyId, agencyId),
        isNull(properties.deletedAt),
        sql`(${properties.refKey} collate "C") in (${sql.join(
          keys.map((k) => sql`${k}`),
          sql`, `,
        )})`,
      ),
    );
}
