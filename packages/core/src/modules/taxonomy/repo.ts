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
  propertyTypeAliases,
  propertyTypeGroups,
  propertyTypeGroupTranslations,
  propertyTypes,
  propertyTypeTranslations,
} from '@inmolink/db/schema/taxonomy';
import { FALLBACK_CONTENT_LOCALE } from '@inmolink/i18n';
import { and, eq, inArray, isNull, notInArray, type SQLWrapper, sql } from 'drizzle-orm';
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

/** Every location with its localized name and slug (statement 1). No geometry. */
export async function localizedLocations(tx: Tx, locale: string) {
  return tx
    .selectDistinctOn([locations.id], {
      id: locations.id,
      parentId: locations.parentId,
      depth: locations.depth,
      level: locations.level,
      code: locations.code,
      sort: locations.sort,
      name: locationTranslations.name,
      slug: locationTranslations.slug,
    })
    .from(locations)
    .innerJoin(locationTranslations, eq(locationTranslations.locationId, locations.id))
    .orderBy(locations.id, ...pick(locationTranslations.locale, locale));
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

export async function catalogAliases(tx: Tx, kind: CatalogKind, ownerId: string) {
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
