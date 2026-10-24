/**
 * taxonomy queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/taxonomy` — other modules' tables fail `pnpm check:boundaries`.
 */
import type { Tx } from '@inmolink/db';
import {
  featureAliases,
  featureGroups,
  featureGroupTranslations,
  features,
  featureTranslations,
  locationAliases,
  locationGroupMembers,
  locationGroups,
  locationGroupTranslations,
  locations,
  locationTranslations,
  nameKey,
  propertyTypeAliases,
  propertyTypeGroups,
  propertyTypeGroupTranslations,
  propertyTypes,
  propertyTypeTranslations,
  taxonomyUnmatched,
} from '@inmolink/db/schema/taxonomy';
import { FALLBACK_CONTENT_LOCALE } from '@inmolink/i18n';
import { and, desc, eq, inArray, isNull, notInArray, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

export interface NewLocation {
  id: string;
  parentId: string | null;
  level: string;
  depth: number;
  code: string | null;
  centroidGeoJson: string | null;
  polygonGeoJson: string | null;
}

const geom = (geoJson: string | null) => (geoJson ? sql`ST_SetSRID(ST_GeomFromGeoJSON(${geoJson}), 4326)` : null);

export async function getDepth(tx: Tx, id: string): Promise<number | null> {
  const [row] = await tx.select({ depth: locations.depth }).from(locations).where(eq(locations.id, id)).limit(1);
  return row?.depth ?? null;
}

export async function insertLocation(
  tx: Tx,
  l: NewLocation,
  translations: { locale: string; name: string; slug: string }[],
): Promise<void> {
  await tx.insert(locations).values({
    id: l.id,
    parentId: l.parentId,
    level: l.level,
    depth: l.depth,
    code: l.code,
    centroid: geom(l.centroidGeoJson) as never,
    polygon: geom(l.polygonGeoJson) as never,
  });
  await tx
    .insert(locationTranslations)
    .values(translations.map((t) => ({ ...t, locationId: l.id, parentId: l.parentId })));
}

export async function insertAlias(tx: Tx, row: { id: string; locationId: string; alias: string; aliasKey: string }) {
  await tx.insert(locationAliases).values(row);
}

export async function insertGroup(
  tx: Tx,
  group: { id: string; key: string },
  translations: { locale: string; name: string; slug: string }[],
  memberIds: string[],
): Promise<void> {
  await tx.insert(locationGroups).values(group);
  await tx.insert(locationGroupTranslations).values(translations.map((t) => ({ ...t, groupId: group.id })));
  if (memberIds.length > 0) {
    await tx.insert(locationGroupMembers).values(memberIds.map((locationId) => ({ groupId: group.id, locationId })));
  }
}

export async function existingLocationIds(tx: Tx, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx.select({ id: locations.id }).from(locations).where(inArray(locations.id, ids));
  return new Set(rows.map((r) => r.id));
}

/**
 * Every ancestor of each location (the tree is ≤ 4 deep): one recursive statement per 1,000 distinct IDs
 * (each ID is a bind parameter; Postgres allows 65,535 per statement).
 */
export async function locationAncestors(tx: Tx, ids: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 1000) {
    const res = await tx.execute(sql`
      with recursive up(id, ancestor) as (
        select l.id, l.parent_id from ${locations} l
         where l.id = any(${textArray(unique.slice(i, i + 1000))}::uuid[]) and l.parent_id is not null
        union all
        select up.id, p.parent_id from up join ${locations} p on p.id = up.ancestor where p.parent_id is not null
      )
      select id, ancestor from up`);
    for (const r of rowsOf<{ id: string; ancestor: string }>(res)) {
      out.set(r.id, (out.get(r.id) ?? new Set()).add(r.ancestor));
    }
  }
  return out;
}

/** A location's depth and the ids of it and its ancestors by depth (1 country … 4 area). One statement. */
/** Whether a property type exists (a reference checked before it is stored without a foreign key, S10-07). */
export async function propertyTypeExists(tx: Tx, id: string): Promise<boolean> {
  const [row] = await tx.select({ id: propertyTypes.id }).from(propertyTypes).where(eq(propertyTypes.id, id));
  return row !== undefined;
}

export async function lineage(tx: Tx, id: string): Promise<{ depth: number; byDepth: Map<number, string> } | null> {
  const res = await tx.execute(sql`
    with recursive up(id, parent_id, depth) as (
      select l.id, l.parent_id, l.depth::int from ${locations} l where l.id = ${id}
      union all
      select p.id, p.parent_id, p.depth::int from up join ${locations} p on p.id = up.parent_id
    )
    select id, depth from up`);
  const rows = rowsOf<{ id: string; depth: number }>(res);
  if (rows.length === 0) return null;
  return { depth: Math.max(...rows.map((r) => r.depth)), byDepth: new Map(rows.map((r) => [r.depth, r.id])) };
}

/**
 * Each location's own id and its ancestors' ids by depth (1 country … 4 area), for many locations: one statement per
 * 1,000 (feed imports, S6-02). A missing id has no entry.
 */
export async function lineages(tx: Tx, ids: readonly string[]): Promise<Map<string, Map<number, string>>> {
  const out = new Map<string, Map<number, string>>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 1000) {
    const res = await tx.execute(sql`
      with recursive up(origin, id, parent_id, depth) as (
        select l.id, l.id, l.parent_id, l.depth::int from ${locations} l
         where l.id = any(${textArray(unique.slice(i, i + 1000))}::uuid[])
        union all
        select up.origin, p.id, p.parent_id, p.depth::int from up join ${locations} p on p.id = up.parent_id
      )
      select origin, id, depth from up`);
    for (const r of rowsOf<{ origin: string; id: string; depth: number }>(res)) {
      const byDepth = out.get(r.origin) ?? new Map<number, string>();
      byDepth.set(r.depth, r.id);
      out.set(r.origin, byDepth);
    }
  }
  return out;
}

/** The deepest location whose polygon covers the point: GiST on `polygon`, then the deepest level wins. */
export async function deepestAt(tx: Tx, lon: number, lat: number): Promise<string | null> {
  const rows = await tx
    .select({ id: locations.id })
    .from(locations)
    .where(sql`ST_Covers(${locations.polygon}, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326))`)
    .orderBy(sql`${locations.depth} desc`)
    .limit(1);
  return rows[0]?.id ?? null;
}

/** Name and slug in the wanted locale, else the fallback content locale, else any. */
export async function localized(tx: Tx, id: string, locale: string) {
  const [row] = await tx
    .select({
      id: locations.id,
      parentId: locations.parentId,
      level: locations.level,
      code: locations.code,
      name: locationTranslations.name,
      slug: locationTranslations.slug,
    })
    .from(locations)
    .innerJoin(locationTranslations, eq(locationTranslations.locationId, locations.id))
    .where(eq(locations.id, id))
    .orderBy(
      sql`(${locationTranslations.locale} = ${locale}) desc, (${locationTranslations.locale} = ${FALLBACK_CONTENT_LOCALE}) desc`,
    )
    .limit(1);
  return row ?? null;
}

export async function findByAliasKey(tx: Tx, aliasKey: string): Promise<string | null> {
  const [row] = await tx
    .select({ locationId: locationAliases.locationId })
    .from(locationAliases)
    .where(eq(locationAliases.aliasKey, aliasKey))
    .limit(1);
  return row?.locationId ?? null;
}

// ---- Property types and features (S2-02): one code path for both families -----------------------------------

export type CatalogKind = 'propertyType' | 'feature';

const FAMILIES = {
  propertyType: {
    groups: propertyTypeGroups,
    groupTr: propertyTypeGroupTranslations,
    items: propertyTypes,
    itemTr: propertyTypeTranslations,
    aliases: propertyTypeAliases,
  },
  // Features have one extra column (`icon`); everything the shared code touches has the same shape.
  feature: {
    groups: featureGroups,
    groupTr: featureGroupTranslations,
    items: features as unknown as typeof propertyTypes,
    itemTr: featureTranslations,
    aliases: featureAliases,
  },
} as const;

type Translations = { locale: string; name: string; slug: string }[];

export async function insertCatalogGroup(
  tx: Tx,
  kind: CatalogKind,
  g: { id: string; key: string; sort: number },
  translations: Translations,
): Promise<void> {
  const f = FAMILIES[kind];
  await tx.insert(f.groups).values(g);
  await tx.insert(f.groupTr).values(translations.map((t) => ({ ...t, ownerId: g.id })));
}

export async function insertCatalogItem(
  tx: Tx,
  kind: CatalogKind,
  item: { id: string; groupId: string; key: string; sort: number; icon?: string },
  translations: Translations,
): Promise<void> {
  const f = FAMILIES[kind];
  await tx.insert(f.items).values(item as never);
  await tx.insert(f.itemTr).values(translations.map((t) => ({ ...t, ownerId: item.id })));
}

export async function catalogGroupExists(tx: Tx, kind: CatalogKind, id: string): Promise<boolean> {
  const f = FAMILIES[kind];
  const rows = await tx.select({ id: f.groups.id }).from(f.groups).where(eq(f.groups.id, id)).limit(1);
  return rows.length > 0;
}

export async function catalogItemExists(tx: Tx, kind: CatalogKind, id: string): Promise<boolean> {
  const f = FAMILIES[kind];
  const rows = await tx.select({ id: f.items.id }).from(f.items).where(eq(f.items.id, id)).limit(1);
  return rows.length > 0;
}

export async function insertCatalogAlias(
  tx: Tx,
  kind: CatalogKind,
  row: { id: string; ownerId: string; alias: string; aliasKey: string },
): Promise<void> {
  await tx.insert(FAMILIES[kind].aliases).values(row);
}

export async function findCatalogByAliasKey(tx: Tx, kind: CatalogKind, aliasKey: string): Promise<string | null> {
  const a = FAMILIES[kind].aliases;
  const [row] = await tx.select({ ownerId: a.ownerId }).from(a).where(eq(a.aliasKey, aliasKey)).limit(1);
  return row?.ownerId ?? null;
}

/** Item with name and slug in the wanted locale, else English, else any. `icon` is null for property types. */
export async function localizedCatalogItem(tx: Tx, kind: CatalogKind, id: string, locale: string) {
  const f = FAMILIES[kind];
  const [row] = await tx
    .select({
      id: f.items.id,
      groupId: f.items.groupId,
      key: f.items.key,
      name: f.itemTr.name,
      slug: f.itemTr.slug,
      icon: kind === 'feature' ? sql<string | null>`${features.icon}` : sql<string | null>`null`,
    })
    .from(f.items)
    .innerJoin(f.itemTr, eq(f.itemTr.ownerId, f.items.id))
    .where(eq(f.items.id, id))
    .orderBy(sql`(${f.itemTr.locale} = ${locale}) desc, (${f.itemTr.locale} = ${FALLBACK_CONTENT_LOCALE}) desc`)
    .limit(1);
  return row ?? null;
}

// ---- Localized taxonomy (S2-03): three statements load everything for one locale -----------------------------
// Full reads of small reference tables, run only on a cache miss (then cached per locale for an hour).
// The translation per row: the wanted locale, else the fallback content locale, else the first alphabetically.

const pick = (locale: AnyPgColumn, wanted: string) => [
  sql`(${locale} = ${wanted}) desc`,
  sql`(${locale} = ${FALLBACK_CONTENT_LOCALE}) desc`,
  sql`${locale}`,
];

export type LocalizedLocationRow = {
  id: string;
  parentId: string | null;
  depth: number;
  level: string;
  code: string | null;
  sort: number;
  name: string;
  slug: string;
};

/**
 * Locations with their localized name and slug (S3-F2): two keyed joins on the translation primary key (the
 * wanted and the fallback locale) — no DISTINCT ON over every locale, so no sort and no spill on a Spain-sized
 * tree. A location with neither falls back to its first locale through a lateral probe that runs only then.
 * `where` filters on `l.*` (e.g. `l.depth <= 2`, `l.parent_id = …`); `childCount` adds the children count.
 */
export function localizedLocationsSql(locale: string, opts: { where?: SQL; childCount?: boolean } = {}): SQL {
  const tr = locationTranslations;
  // `coalesce` stops at the first non-null argument, so the "any locale" subqueries run only for the rare
  // location with neither translation (ordered by locale: name and slug come from the same row).
  const any = (col: 'name' | 'slug') =>
    sql`(select x.${sql.raw(col)} from ${tr} x where x.location_id = l.id order by x.locale limit 1)`;
  return sql`select * from (select l.id, l.parent_id as "parentId", l.depth, l.level, l.code, l.sort,
      coalesce(w.name, f.name, ${any('name')}) as name, coalesce(w.slug, f.slug, ${any('slug')}) as slug
      ${opts.childCount ? sql`, (select count(*)::int from ${locations} c where c.parent_id = l.id) as "childCount"` : sql``}
    from ${locations} l
    left join ${tr} w on w.location_id = l.id and w.locale = ${locale}
    left join ${tr} f on f.location_id = l.id and f.locale = ${FALLBACK_CONTENT_LOCALE}
    ${opts.where ? sql`where ${opts.where}` : sql``}) t
   where t.name is not null`;
}

/** Every location with its localized name and slug (statement 1). No geometry. */
export async function localizedLocations(tx: Tx, locale: string): Promise<LocalizedLocationRow[]> {
  return rowsOf<LocalizedLocationRow>(await tx.execute(localizedLocationsSql(locale)));
}

/** Countries and regions with their child counts: the staff editor's first view (S3-F2). */
export async function localizedTopLocations(tx: Tx, locale: string) {
  return rowsOf<LocalizedLocationRow & { childCount: number }>(
    await tx.execute(localizedLocationsSql(locale, { where: sql`l.level in ('COUNTRY', 'REGION')`, childCount: true })),
  );
}

/** One location's direct children with their child counts, for the staff editor's expand (S3-F2). */
export async function localizedChildren(tx: Tx, parentId: string, locale: string) {
  return rowsOf<LocalizedLocationRow & { childCount: number }>(
    await tx.execute(localizedLocationsSql(locale, { where: sql`l.parent_id = ${parentId}`, childCount: true })),
  );
}

/** Every location group, localized, with its member ids (statement 2). */
export async function localizedLocationGroups(tx: Tx, locale: string) {
  const m = locationGroupMembers;
  return tx
    .selectDistinctOn([locationGroups.id], {
      id: locationGroups.id,
      key: locationGroups.key,
      name: locationGroupTranslations.name,
      slug: locationGroupTranslations.slug,
      locationIds: sql<string[]>`coalesce((select array_agg(${m.locationId} order by ${m.locationId})::text[]
        from ${m} where ${m.groupId} = ${locationGroups.id}), '{}'::text[])`,
    })
    .from(locationGroups)
    .innerJoin(locationGroupTranslations, eq(locationGroupTranslations.groupId, locationGroups.id))
    .orderBy(locationGroups.id, ...pick(locationGroupTranslations.locale, locale));
}

export type CatalogRowKind = 'TYPE_GROUP' | 'TYPE' | 'FEATURE_GROUP' | 'FEATURE';

export type CatalogRow = {
  kind: CatalogRowKind;
  id: string;
  group_id: string | null;
  key: string;
  sort: number;
  icon: string | null;
  name: string;
  slug: string;
};

/** Property type groups, types, feature groups and features, localized, in one UNION ALL (statement 3). */
export async function localizedCatalog(tx: Tx, locale: string): Promise<CatalogRow[]> {
  type Owner = SQLWrapper & { id: AnyPgColumn; key: AnyPgColumn; sort: AnyPgColumn };
  type Tr = SQLWrapper & { ownerId: AnyPgColumn; locale: AnyPgColumn; name: AnyPgColumn; slug: AnyPgColumn };
  const part = (kind: CatalogRowKind, p: { table: Owner; tr: Tr; groupId?: AnyPgColumn; icon?: AnyPgColumn }) =>
    sql`(select distinct on (${p.table.id}) ${kind}::text as kind, ${p.table.id} as id,
      ${p.groupId ?? sql`null::uuid`} as group_id, ${p.table.key} as key, ${p.table.sort} as sort,
      ${p.icon ?? sql`null::text`} as icon, ${p.tr.name} as name, ${p.tr.slug} as slug
    from ${p.table} inner join ${p.tr} on ${p.tr.ownerId} = ${p.table.id}
    order by ${p.table.id}, ${sql.join(pick(p.tr.locale, locale), sql`, `)})`;
  const { propertyType: t, feature: f } = FAMILIES;
  const r = await tx.execute<CatalogRow>(
    sql.join(
      [
        part('TYPE_GROUP', { table: t.groups, tr: t.groupTr }),
        part('TYPE', { table: propertyTypes, tr: t.itemTr, groupId: propertyTypes.groupId }),
        part('FEATURE_GROUP', { table: f.groups, tr: f.groupTr }),
        part('FEATURE', { table: features, tr: f.itemTr, groupId: features.groupId, icon: features.icon }),
      ],
      sql` union all `,
    ),
  );
  return r.rows;
}

// ---- Staff admin (S2-04) --------------------------------------------------------------------------------------

type GeoJson = { type: string; coordinates: unknown };

/** One location with every translation, its aliases and its geometry as GeoJSON. Three statements. */
export async function locationDetail(tx: Tx, id: string) {
  const [row] = await tx
    .select({
      id: locations.id,
      parentId: locations.parentId,
      level: locations.level,
      code: locations.code,
      sort: locations.sort,
      centroid: sql<string | null>`ST_AsGeoJSON(${locations.centroid}, 6)`,
      polygon: sql<string | null>`ST_AsGeoJSON(${locations.polygon}, 6)`,
    })
    .from(locations)
    .where(eq(locations.id, id))
    .limit(1);
  if (!row) return null;
  const translations = await tx
    .select({ locale: locationTranslations.locale, name: locationTranslations.name, slug: locationTranslations.slug })
    .from(locationTranslations)
    .where(eq(locationTranslations.locationId, id))
    .orderBy(locationTranslations.locale);
  const aliases = await tx
    .select({ id: locationAliases.id, alias: locationAliases.alias })
    .from(locationAliases)
    .where(eq(locationAliases.locationId, id))
    .orderBy(locationAliases.alias);
  const geo = (v: string | null) => (v ? (JSON.parse(v) as GeoJson) : null);
  return { ...row, centroid: geo(row.centroid), polygon: geo(row.polygon), translations, aliases };
}

/** Whether PostGIS accepts the GeoJSON as one valid, non-self-intersecting area. */
export async function polygonValid(tx: Tx, geoJson: string): Promise<boolean> {
  const res = await tx.execute(sql`select ST_IsValid(ST_SetSRID(ST_GeomFromGeoJSON(${geoJson}), 4326)) as ok`);
  const rows = (Array.isArray(res) ? res : (res as unknown as { rows: unknown[] }).rows) as { ok: boolean }[];
  return rows[0]?.ok === true;
}

export async function updateLocationFields(
  tx: Tx,
  id: string,
  f: { code?: string | null; centroidGeoJson?: string | null; polygonGeoJson?: string | null },
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: sql`now()` };
  if (f.code !== undefined) set.code = f.code;
  if (f.centroidGeoJson !== undefined) set.centroid = geom(f.centroidGeoJson);
  if (f.polygonGeoJson !== undefined) set.polygon = geom(f.polygonGeoJson);
  await tx.update(locations).set(set).where(eq(locations.id, id));
}

/** Makes the stored translations exactly `translations` (upsert, then drop locales that were left out). */
export async function replaceLocationTranslations(
  tx: Tx,
  id: string,
  parentId: string | null,
  translations: Translations,
): Promise<void> {
  await tx.delete(locationTranslations).where(
    and(
      eq(locationTranslations.locationId, id),
      notInArray(
        locationTranslations.locale,
        translations.map((t) => t.locale),
      ),
    ),
  );
  await tx
    .insert(locationTranslations)
    .values(translations.map((t) => ({ ...t, locationId: id, parentId })))
    .onConflictDoUpdate({
      target: [locationTranslations.locationId, locationTranslations.locale],
      set: { name: sql`excluded.name`, slug: sql`excluded.slug` },
    });
}

export async function deleteLocationAlias(tx: Tx, locationId: string, aliasId: string): Promise<boolean> {
  const rows = await tx
    .delete(locationAliases)
    .where(and(eq(locationAliases.id, aliasId), eq(locationAliases.locationId, locationId)))
    .returning({ id: locationAliases.id });
  return rows.length > 0;
}

export async function locationParent(tx: Tx, id: string): Promise<{ parentId: string | null } | null> {
  const [row] = await tx.select({ parentId: locations.parentId }).from(locations).where(eq(locations.id, id)).limit(1);
  return row ?? null;
}

/** The ids under one parent (roots when null), locked so two concurrent reorders do not interleave. */
export async function lockedSiblingIds(tx: Tx, parentId: string | null): Promise<string[]> {
  const rows = await tx
    .select({ id: locations.id })
    .from(locations)
    .where(parentId === null ? isNull(locations.parentId) : eq(locations.parentId, parentId))
    .for('update');
  return rows.map((r) => r.id);
}

/** `sort` = position in `orderedIds`, in one statement. */
export async function setLocationSorts(tx: Tx, orderedIds: string[]): Promise<void> {
  await tx.execute(sql`update ${locations} as l set sort = v.pos::smallint, updated_at = now()
    from (select * from unnest(string_to_array(${orderedIds.join(',')}, ',')::uuid[]) with ordinality as t(id, pos)) v
    where l.id = v.id`);
}

/** The next free position among a parent's children (new locations go last). */
export async function nextLocationSort(tx: Tx, parentId: string | null): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`coalesce(max(${locations.sort}) + 1, 0)` })
    .from(locations)
    .where(parentId === null ? isNull(locations.parentId) : eq(locations.parentId, parentId));
  return Math.min(Number(row?.n ?? 0), 32000);
}

export async function setLocationSort(tx: Tx, id: string, sort: number): Promise<void> {
  await tx.update(locations).set({ sort }).where(eq(locations.id, id));
}

/** Group ids of a kind, or the item ids of one group, locked for a reorder. */
export async function lockedCatalogIds(tx: Tx, kind: CatalogKind, groupId: string | null): Promise<string[]> {
  const f = FAMILIES[kind];
  const rows =
    groupId === null
      ? await tx.select({ id: f.groups.id }).from(f.groups).for('update')
      : await tx.select({ id: f.items.id }).from(f.items).where(eq(f.items.groupId, groupId)).for('update');
  return rows.map((r) => r.id);
}

export async function setCatalogSorts(
  tx: Tx,
  kind: CatalogKind,
  groupId: string | null,
  orderedIds: string[],
): Promise<void> {
  const f = FAMILIES[kind];
  const table = groupId === null ? f.groups : f.items;
  await tx.execute(sql`update ${table} as t set sort = v.pos::smallint
    from (select * from unnest(string_to_array(${orderedIds.join(',')}, ',')::uuid[]) with ordinality as o(id, pos)) v
    where t.id = v.id`);
}

export async function replaceCatalogTranslations(
  tx: Tx,
  kind: CatalogKind,
  scope: 'group' | 'item',
  ownerId: string,
  translations: Translations,
): Promise<boolean> {
  const f = FAMILIES[kind];
  const exists =
    scope === 'group' ? await catalogGroupExists(tx, kind, ownerId) : await catalogItemExists(tx, kind, ownerId);
  if (!exists) return false;
  const tr = scope === 'group' ? f.groupTr : f.itemTr;
  await tx.delete(tr).where(
    and(
      eq(tr.ownerId, ownerId),
      notInArray(
        tr.locale,
        translations.map((t) => t.locale),
      ),
    ),
  );
  await tx
    .insert(tr)
    .values(translations.map((t) => ({ ...t, ownerId })))
    .onConflictDoUpdate({
      target: [tr.ownerId, tr.locale],
      set: { name: sql`excluded.name`, slug: sql`excluded.slug` },
    });
  return true;
}

export async function deleteCatalogAlias(
  tx: Tx,
  kind: CatalogKind,
  ownerId: string,
  aliasId: string,
): Promise<boolean> {
  const a = FAMILIES[kind].aliases;
  const rows = await tx
    .delete(a)
    .where(and(eq(a.id, aliasId), eq(a.ownerId, ownerId)))
    .returning({ id: a.id });
  return rows.length > 0;
}

async function catalogAliases(tx: Tx, kind: CatalogKind, ownerId: string) {
  const a = FAMILIES[kind].aliases;
  return tx.select({ id: a.id, alias: a.alias }).from(a).where(eq(a.ownerId, ownerId)).orderBy(a.alias);
}

/** All translations of a catalog group or item, and the aliases of an item. Null when it does not exist. */
export async function catalogDetail(tx: Tx, kind: CatalogKind, scope: 'group' | 'item', id: string) {
  const f = FAMILIES[kind];
  const tr = scope === 'group' ? f.groupTr : f.itemTr;
  const translations = await tx
    .select({ locale: tr.locale, name: tr.name, slug: tr.slug })
    .from(tr)
    .where(eq(tr.ownerId, id))
    .orderBy(tr.locale);
  if (translations.length === 0) return null;
  const aliases = scope === 'item' ? await catalogAliases(tx, kind, id) : [];
  return { translations, aliases };
}

// ---- Alias resolver and unmatched queue (S2-05) ---------------------------------------------------------------

export type ResolveKind = 'location' | 'propertyType' | 'feature';

/** Per kind: the alias table and the translation table (with their owner columns) the resolver reads. */
const MATCH = {
  location: {
    aliases: locationAliases,
    aliasOwner: locationAliases.locationId,
    tr: locationTranslations,
    trName: locationTranslations.name,
    trKey: locationTranslations.nameKey,
    trOwner: locationTranslations.locationId,
    trLocale: locationTranslations.locale,
  },
  propertyType: {
    aliases: propertyTypeAliases,
    aliasOwner: propertyTypeAliases.ownerId,
    tr: propertyTypeTranslations,
    trName: propertyTypeTranslations.name,
    trKey: propertyTypeTranslations.nameKey,
    trOwner: propertyTypeTranslations.ownerId,
    trLocale: propertyTypeTranslations.locale,
  },
  feature: {
    aliases: featureAliases,
    aliasOwner: featureAliases.ownerId,
    tr: featureTranslations,
    trName: featureTranslations.name,
    trKey: featureTranslations.nameKey,
    trOwner: featureTranslations.ownerId,
    trLocale: featureTranslations.locale,
  },
} as const;

const textArray = (keys: string[]) =>
  sql`array[${sql.join(
    keys.map((k) => sql`${k}`),
    sql`, `,
  )}]::text[]`;

function rowsOf<T>(res: unknown): T[] {
  return (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as T[];
}

/** A value to match: its normalised key, and (locations) the parent it must sit under — null: none given. */
export type KeyQuery = { key: string; parentId: string | null };
/** Matches of a `KeyQuery` (the same key under two parents is two queries). */
export type KeyMatch = { key: string; parentId: string | null; id: string; score: number };

/** The keys and the parents as two array parameters (S7-F10 review: a constant parameter count, whatever the batch). */
const keysParam = (queries: readonly KeyQuery[]) => sql`${sql.param(queries.map((q) => q.key))}::text[]`;
const parentsParam = (queries: readonly KeyQuery[]) => sql`${sql.param(queries.map((q) => q.parentId))}::uuid[]`;

/**
 * The queries as a relation `q(k, p)`: one row per (key, parent) pair, so a whole level of a batch — every parent its
 * values sit under — is matched in one statement (S7-F10), not one per parent. Two parameters, never one per pair
 * (65,535 binds would cap a batch at ~32k pairs).
 */
const queriesSql = (queries: readonly KeyQuery[]) =>
  sql`unnest(${keysParam(queries)}, ${parentsParam(queries)}) as q(k, p)`;

/**
 * Locations only: keep candidates on the query's level and, when its row names one (`q.p`), under its parent — the
 * hint a feed gives. A correlated scalar subquery, one primary-key probe per candidate: as `exists` the planner may
 * hash-join a Seq Scan of `locations` filtered by level when its statistics drift (S4-F2, seen on a long-lived test
 * database), and `owner in (select … where level = …)` read every location; a scalar subquery is never pulled up into a
 * join. `scoped`: some query has a parent, or a level is given.
 */
function ownerScope(kind: ResolveKind, owner: SQLWrapper, scoped: boolean, level: string | undefined) {
  if (kind !== 'location' || !scoped) return sql``;
  const onLevel = level ? sql` and ${locations.level} = ${level}` : sql``;
  return sql` and (select true from ${locations} where ${locations.id} = ${owner}
    and (q.p is null or ${locations.parentId} = q.p)${onLevel})`;
}

const isScoped = (queries: readonly KeyQuery[], level: string | undefined) =>
  level !== undefined || queries.some((q) => q.parentId !== null);

/** Trigram candidates read per key, most similar first, before they are grouped per owner. */
const FUZZY_ALIASES_PER_KEY = 10;
/** More for names: one owner has a row per locale, often with the same name. */
const FUZZY_NAMES_PER_KEY = 20;
/**
 * `pg_trgm.similarity_threshold` for `%` while resolving, set explicitly so a server default cannot move it.
 * Below it a candidate is not even a hint for staff. On a Spain-sized tree a GIN probe costs ≈5 ms per key at
 * 0.3 (≈2 ms at 0.5, which would drop the low-confidence hints S2-05 shows staff).
 */
export const FUZZY_FLOOR = 0.3;

/**
 * Exact matches of normalised spellings (`aliasKey` form): feed aliases and canonical names in any locale.
 * One statement for the whole batch, every (key, parent) query at once; `= any($keys)` keeps both lookups on their
 * btrees (alias unique, name key) — joined to `q` alone the planner hash-joined a Seq Scan of the aliases. An alias
 * is globally unique; a name may be shared (two cities called the same), so the caller treats a query with several
 * name matches as ambiguous.
 */
export function exactMatchesSql(kind: ResolveKind, queries: readonly KeyQuery[], level?: string) {
  const m = MATCH[kind];
  const scoped = isScoped(queries, level);
  return sql`
    select q.k as key, q.p as "parentId", ${m.aliasOwner} as id, true as "viaAlias"
      from ${queriesSql(queries)}
      join ${m.aliases} on ${m.aliases.aliasKey} = q.k
     where ${m.aliases.aliasKey} = any(${keysParam(queries)}) ${ownerScope(kind, m.aliasOwner, scoped, level)}
    union all
    select q.k as key, q.p as "parentId", ${m.trOwner} as id, false as "viaAlias"
      from ${queriesSql(queries)}
      join ${m.tr} on ${m.trKey} = q.k
     where ${m.trKey} = any(${keysParam(queries)}) ${ownerScope(kind, m.trOwner, scoped, level)}
     group by 1, 2, 3`;
}

export async function exactMatches(tx: Tx, kind: ResolveKind, queries: readonly KeyQuery[], level?: string) {
  type Row = { key: string; parentId: string | null; id: string; viaAlias: boolean };
  if (queries.length === 0) return [] as Row[];
  return rowsOf<Row>(await tx.execute(exactMatchesSql(kind, queries, level)));
}

/**
 * Trigram candidates for queries with no exact match: per query (LATERAL, so each key is its own GIN `%` probe; a
 * plain join seq-scanned the names), the most similar aliases and names, then the best similarity per
 * (query, owner), at most 3 per query, best first. One statement for the whole batch, after `fuzzyThresholdSql`.
 */
export function fuzzyMatchesSql(kind: ResolveKind, queries: readonly KeyQuery[], level?: string) {
  const m = MATCH[kind];
  const scoped = isScoped(queries, level);
  return sql`
    select key, "parentId", id, score from (
      select key, "parentId", id, score,
             row_number() over (partition by key, "parentId" order by score desc, id) as rn from (
        select key, "parentId", id, max(score) as score from (
          select q.k as key, q.p as "parentId", a.id, a.score
            from ${queriesSql(queries)}
            cross join lateral (
              select ${m.aliasOwner} as id, similarity(${m.aliases.aliasKey}, q.k) as score
                from ${m.aliases}
               where ${m.aliases.aliasKey} % q.k ${ownerScope(kind, m.aliasOwner, scoped, level)}
               order by score desc
               limit ${FUZZY_ALIASES_PER_KEY}) a
          union all
          select q.k, q.p, n.id, n.score
            from ${queriesSql(queries)}
            cross join lateral (
              select ${m.trOwner} as id, similarity(${m.trKey}, q.k) as score
                from ${m.tr}
               where ${m.trKey} % q.k ${ownerScope(kind, m.trOwner, scoped, level)}
               order by score desc
               limit ${FUZZY_NAMES_PER_KEY}) n) c
         group by key, "parentId", id) best) ranked
     where rn <= 3 order by key, "parentId", score desc`;
}

/** Transaction-local: `%` keeps candidates at or above `FUZZY_FLOOR` for the rest of this transaction. */
export const fuzzyThresholdSql = () =>
  sql`select set_config('pg_trgm.similarity_threshold', ${String(FUZZY_FLOOR)}, true)`;

export async function fuzzyMatches(
  tx: Tx,
  kind: ResolveKind,
  queries: readonly KeyQuery[],
  level?: string,
): Promise<KeyMatch[]> {
  if (queries.length === 0) return [];
  await tx.execute(fuzzyThresholdSql());
  const res = await tx.execute(fuzzyMatchesSql(kind, queries, level));
  return rowsOf<KeyMatch>(res).map((r) => ({ ...r, score: Number(r.score) }));
}

export type UnmatchedUpsert = {
  id: string;
  kind: ResolveKind;
  valueKey: string;
  value: string;
  count: number;
  examples: string[];
  candidateId: string | null;
  candidateScore: number | null;
};

/** The location, property type or feature an alias key already belongs to, if any. */
export async function aliasOwner(tx: Tx, kind: ResolveKind, key: string): Promise<string | null> {
  if (kind === 'location') return findByAliasKey(tx, key);
  const a = FAMILIES[kind].aliases;
  const [row] = await tx.select({ ownerId: a.ownerId }).from(a).where(eq(a.aliasKey, key)).limit(1);
  return row?.ownerId ?? null;
}

/** Whether `excluded.value_key` is an alias of the row's kind (a mapped spelling the resolver refused under hints). */
const aliasExists = sql`case excluded.kind
  when 'location' then exists (select 1 from ${locationAliases} a where a.alias_key = excluded.value_key)
  when 'propertyType' then exists (select 1 from ${propertyTypeAliases} a where a.alias_key = excluded.value_key)
  else exists (select 1 from ${featureAliases} a where a.alias_key = excluded.value_key) end`;

/** Rows per insert: ~8 bind parameters each, far below Postgres's 65,535. */
const UPSERT_CHUNK = 1000;

/**
 * Counts the values into the queue. A value staff mapped earlier reopens only when its alias is gone; while the
 * alias exists, staff could not map it again. Rows go in key order, so concurrent imports lock them in the same
 * order (no deadlock).
 */
export async function upsertUnmatched(tx: Tx, rows: UnmatchedUpsert[]): Promise<void> {
  const sorted = [...rows].sort((a, b) =>
    a.kind === b.kind ? (a.valueKey < b.valueKey ? -1 : a.valueKey > b.valueKey ? 1 : 0) : a.kind < b.kind ? -1 : 1,
  );
  for (let i = 0; i < sorted.length; i += UPSERT_CHUNK)
    await upsertUnmatchedChunk(tx, sorted.slice(i, i + UPSERT_CHUNK));
}

async function upsertUnmatchedChunk(tx: Tx, rows: UnmatchedUpsert[]): Promise<void> {
  const t = taxonomyUnmatched;
  const reopen = sql`${t.status} = 'MAPPED' and not ${aliasExists}`;
  await tx
    .insert(t)
    .values(rows)
    .onConflictDoUpdate({
      target: [t.kind, t.valueKey],
      set: {
        count: sql`${t.count} + excluded.count`,
        lastSeenAt: sql`now()`,
        candidateId: sql`excluded.candidate_id`,
        candidateScore: sql`excluded.candidate_score`,
        // the 5 most recent, newest first: this run's examples, then the kept ones (S3-F1)
        examples: sql`(select coalesce(jsonb_agg(e order by o), '[]'::jsonb) from (
          select e, min(o) as o from jsonb_array_elements_text(excluded.examples || ${t.examples}) with ordinality as x(e, o)
           group by e order by o limit 5) l)`,
        status: sql`case when ${reopen} then 'OPEN' else ${t.status} end`,
        mappedToId: sql`case when ${reopen} then null else ${t.mappedToId} end`,
        resolvedAt: sql`case when ${reopen} then null else ${t.resolvedAt} end`,
      },
    });
}

/** A new alias answers the queued value of the same spelling: mark it mapped. Returns whether one was waiting. */
export async function markUnmatchedMapped(tx: Tx, kind: ResolveKind, valueKey: string, targetId: string) {
  const t = taxonomyUnmatched;
  const rows = await tx
    .update(t)
    .set({ status: 'MAPPED', mappedToId: targetId, resolvedAt: sql`now()` })
    .where(and(eq(t.kind, kind), eq(t.valueKey, valueKey), sql`${t.status} <> 'MAPPED'`))
    .returning({ id: t.id });
  return rows.length > 0;
}

export type UnmatchedRow = typeof taxonomyUnmatched.$inferSelect;

export async function getUnmatched(tx: Tx, id: string): Promise<UnmatchedRow | null> {
  const [row] = await tx.select().from(taxonomyUnmatched).where(eq(taxonomyUnmatched.id, id)).limit(1).for('update');
  return row ?? null;
}

export async function setUnmatchedIgnored(tx: Tx, id: string): Promise<void> {
  await tx
    .update(taxonomyUnmatched)
    .set({ status: 'IGNORED', resolvedAt: sql`now()` })
    .where(eq(taxonomyUnmatched.id, id));
}

/** OPEN queue rows per kind (S6-08 import health), off `taxonomy_unmatched_queue_idx`. */
export async function countOpenUnmatched(tx: Tx): Promise<Record<string, number>> {
  const res = await tx.execute<{ kind: string; n: number }>(sql`
    select kind, count(*)::int as n from taxonomy_unmatched where status = 'OPEN' group by kind`);
  return Object.fromEntries(res.rows.map((r) => [r.kind, Number(r.n)]));
}

/**
 * A page of the queue, most-seen first, keyset on (count desc, id). Returns `limit + 1` rows to detect a next page.
 * Stable while imports count (S3-F1): counts only grow, so a value counted again moves above the cursor and is
 * never shown twice; it is at the top on the next first page. Served by `taxonomy_unmatched_status_count_idx`
 * (unfiltered) and `taxonomy_unmatched_queue_idx` (by kind).
 */
export async function listUnmatched(
  tx: Tx,
  q: { kind?: ResolveKind; status: string; after?: { count: number; id: string }; limit: number },
): Promise<UnmatchedRow[]> {
  const t = taxonomyUnmatched;
  const after = q.after
    ? sql`(${t.count} < ${q.after.count} or (${t.count} = ${q.after.count} and ${t.id} > ${q.after.id}))`
    : undefined;
  return tx
    .select()
    .from(t)
    .where(and(eq(t.status, q.status), q.kind ? eq(t.kind, q.kind) : undefined, after))
    .orderBy(desc(t.count), t.id)
    .limit(q.limit + 1);
}

/** Localized names of owners (candidates), one statement: wanted locale, else fallback, else first. */
export async function ownerNames(
  tx: Tx,
  kind: ResolveKind,
  ids: string[],
  locale: string,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const m = MATCH[kind];
  const rows = await tx
    .selectDistinctOn([m.trOwner], { id: m.trOwner, name: m.trName })
    .from(m.tr)
    .where(inArray(m.trOwner, ids))
    .orderBy(m.trOwner, ...pick(m.trLocale, locale));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ---- Bulk aliases (S2-06 legacy import) ----------------------------------------------------------------------

/**
 * Inserts many aliases in one statement; a spelling already owned (by anyone) is skipped, not an error, so
 * one clash never aborts the caller's transaction. Returns the keys written and the owner of each skipped key.
 */
export async function insertAliasesBulk(
  tx: Tx,
  kind: ResolveKind,
  rows: { id: string; ownerId: string; alias: string; aliasKey: string }[],
): Promise<{ inserted: Set<string>; owners: Map<string, string> }> {
  const inserted = new Set<string>();
  const owners = new Map<string, string>();
  const m = MATCH[kind];
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    const res = await tx.execute(sql`
      insert into ${m.aliases} (id, ${sql.raw(kind === 'location' ? 'location_id' : 'owner_id')}, alias, alias_key)
      select * from unnest(${textArray(chunk.map((r) => r.id))}::uuid[], ${textArray(chunk.map((r) => r.ownerId))}::uuid[],
                           ${textArray(chunk.map((r) => r.alias))}, ${textArray(chunk.map((r) => r.aliasKey))})
      on conflict (alias_key) do nothing
      returning alias_key as key`);
    for (const r of rowsOf<{ key: string }>(res)) inserted.add(r.key);
    const skipped = chunk.map((r) => r.aliasKey).filter((k) => !inserted.has(k));
    if (skipped.length > 0) {
      const owned = await tx
        .select({ key: m.aliases.aliasKey, id: m.aliasOwner })
        .from(m.aliases)
        .where(inArray(m.aliases.aliasKey, skipped));
      for (const r of owned) owners.set(r.key, r.id);
    }
    // the queued feed values these spellings answer (S2-05), marked like a staff mapping would
    const done = chunk.filter((r) => inserted.has(r.aliasKey));
    if (done.length > 0) {
      await tx.execute(sql`
        update ${taxonomyUnmatched} u
           set status = 'MAPPED', mapped_to_id = v.owner, resolved_at = now()
          from unnest(${textArray(done.map((r) => r.aliasKey))}, ${textArray(done.map((r) => r.ownerId))}::uuid[]) as v(key, owner)
         where u.kind = ${kind} and u.value_key = v.key and u.status <> 'MAPPED'`);
    }
  }
  return { inserted, owners };
}

// ---- Read models (S5-01) ------------------------------------------------------------------------------------------

/** These locations and their ancestors (id, level), by the location asked for. One statement. */
export async function readModelLineage(tx: Tx, ids: readonly string[]) {
  if (ids.length === 0) return [];
  const res = await tx.execute(sql`
    with recursive up(origin, id, parent_id, level) as (
      select l.id, l.id, l.parent_id, l.level from ${locations} l where l.id = any(${textArray([...ids])}::uuid[])
      union all
      select up.origin, p.id, p.parent_id, p.level from up join ${locations} p on p.id = up.parent_id
    )
    select origin, id, level from up`);
  return rowsOf<{ origin: string; id: string; level: 'COUNTRY' | 'REGION' | 'CITY' | 'AREA' }>(res);
}

/** Names and slugs of these locations, property types and features in `locales` (translation PKs). */
export async function readModelNames(
  tx: Tx,
  ids: { locations: readonly string[]; propertyTypes: readonly string[]; features: readonly string[] },
  locales: readonly string[],
): Promise<{ id: string; locale: string; name: string; slug: string }[]> {
  const loc = textArray([...locales]);
  const parts: SQL[] = [];
  if (ids.locations.length > 0) {
    parts.push(sql`select location_id as id, locale, name, slug from ${locationTranslations}
      where location_id = any(${textArray([...ids.locations])}::uuid[]) and locale = any(${loc}::text[])`);
  }
  if (ids.propertyTypes.length > 0) {
    parts.push(sql`select type_id as id, locale, name, slug from ${propertyTypeTranslations}
      where type_id = any(${textArray([...ids.propertyTypes])}::uuid[]) and locale = any(${loc}::text[])`);
  }
  if (ids.features.length > 0) {
    parts.push(sql`select feature_id as id, locale, name, slug from ${featureTranslations}
      where feature_id = any(${textArray([...ids.features])}::uuid[]) and locale = any(${loc}::text[])`);
  }
  if (parts.length === 0) return [];
  // a stable order: the "any locale" fallback must not flip between rebuilds
  return rowsOf(await tx.execute(sql`${sql.join(parts, sql` union all `)} order by 1, 2`));
}
