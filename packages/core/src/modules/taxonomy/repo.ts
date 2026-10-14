/**
 * taxonomy queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/taxonomy` — other modules' tables fail `pnpm check:boundaries`.
 */
import type { Tx } from '@inmolink/db';
import {
  locationAliases,
  locationGroupMembers,
  locationGroups,
  locationGroupTranslations,
  locations,
  locationTranslations,
} from '@inmolink/db/schema/taxonomy';
import { eq, inArray, sql } from 'drizzle-orm';

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

/** Name and slug in the wanted locale, else English, else any. */
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
    .orderBy(sql`(${locationTranslations.locale} = ${locale}) desc, (${locationTranslations.locale} = 'en') desc`)
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
