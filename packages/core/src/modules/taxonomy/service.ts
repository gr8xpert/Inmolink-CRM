/**
 * taxonomy use cases (PATTERNS §7): `(ctx: Ctx, input) → DTO`. Authorize with `assertCan`, read and
 * write through `./repo`, emit outbox events in the same transaction, never call the network.
 *
 * Locations are shared reference data: reads take a tenant `ctx`; writes take the `tx` of a
 * `withSystem()` call (staff tooling and import scripts), which is how global tables are written.
 */
import type {
  CreateFeatureInput,
  CreateLocationGroupInput,
  CreateLocationInput,
  CreatePropertyTypeInput,
  CreateTypeGroupInput,
  FeatureDto,
  LocationDto,
  LocationLevel,
  PropertyTypeDto,
} from '@inmolink/contracts';
import { PORTAL_MAX_SEARCH_TYPES, PORTAL_ZONE_MAX_MEMBERS } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { isContentLocale } from '@inmolink/i18n';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import type { Ctx } from '../../context';
import { type TaxonomyEntity, taxonomyEvents } from './events';
import { assertCan } from './policy';
import * as repo from './repo';

const DEPTH: Record<LocationLevel, number> = { COUNTRY: 1, REGION: 2, CITY: 3, AREA: 4 };

/** Lowercase, accent-free, single-spaced: the spelling feeds are matched on. */
export function aliasKey(spelling: string): string {
  return spelling
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function pgError(err: unknown): { code?: string; constraint?: string } {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  return e?.cause?.code ? e.cause : (e ?? {});
}

type UniqueCode = 'LOCATION_SLUG_TAKEN' | 'LOCATION_ALIAS_TAKEN' | 'TAXONOMY_KEY_TAKEN' | 'TAXONOMY_ALIAS_TAKEN';

/**
 * A unique violation becomes `code`; for catalog writes a clash on a translation slug index (`*_slug_uq`)
 * gets its own code (S3-F1), so the editor can point at the slug rather than the key.
 */
export async function uniqueOr<T>(
  fn: () => Promise<T>,
  code: UniqueCode,
  slugCode?: 'TAXONOMY_SLUG_TAKEN',
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const pg = pgError(err);
    if (pg.code === '23505') throw new AppError(slugCode && pg.constraint?.endsWith('_slug_uq') ? slugCode : code);
    throw err;
  }
}

/** Translations are written in content locales only (S3-F1); the website API serves no other. */
export function assertContentLocales(translations: readonly { locale: string }[] | undefined): void {
  if (translations?.some((t) => !isContentLocale(t.locale))) throw new AppError('VALIDATION_FAILED');
}

/** Every write ends here: same transaction, so the event exists if and only if the write commits. */
export async function changed(tx: Tx, entity: TaxonomyEntity, id: string): Promise<string> {
  await emit(tx, taxonomyEvents.changed({ entity, id }));
  return id;
}

/** Creates a location with its translations. The parent must be exactly one level above. */
export async function createLocation(tx: Tx, input: CreateLocationInput): Promise<string> {
  assertContentLocales(input.translations);
  const depth = DEPTH[input.level];
  if (input.parentId === null) {
    if (depth !== 1) throw new AppError('LOCATION_PARENT_INVALID');
  } else {
    const parentDepth = await repo.getDepth(tx, input.parentId);
    if (parentDepth === null || parentDepth !== depth - 1) throw new AppError('LOCATION_PARENT_INVALID');
  }
  // An invalid geometry makes `ST_Covers` in the point lookup fail for everyone.
  const polygonGeoJson = input.polygon ? JSON.stringify(input.polygon) : null;
  if (polygonGeoJson && !(await repo.polygonValid(tx, polygonGeoJson))) throw new AppError('LOCATION_POLYGON_INVALID');
  const id = newId();
  await uniqueOr(
    () =>
      repo.insertLocation(
        tx,
        {
          id,
          parentId: input.parentId,
          level: input.level,
          depth,
          code: input.code ?? null,
          centroidGeoJson: input.centroid ? JSON.stringify(input.centroid) : null,
          polygonGeoJson,
        },
        input.translations,
      ),
    'LOCATION_SLUG_TAKEN',
  );
  return changed(tx, 'location', id);
}

/** Maps a feed spelling to a location. One spelling maps to one location; a queued value of it is marked mapped (S2-05). */
export async function addLocationAlias(tx: Tx, locationId: string, alias: string): Promise<string> {
  if ((await repo.getDepth(tx, locationId)) === null) throw new AppError('LOCATION_NOT_FOUND');
  const key = aliasKey(alias);
  if (!key) throw new AppError('VALIDATION_FAILED');
  const id = newId();
  await uniqueOr(() => repo.insertAlias(tx, { id, locationId, alias, aliasKey: key }), 'LOCATION_ALIAS_TAKEN');
  await repo.markUnmatchedMapped(tx, 'location', key, locationId);
  return changed(tx, 'locationAlias', id);
}

export async function createLocationGroup(tx: Tx, input: CreateLocationGroupInput): Promise<string> {
  assertContentLocales(input.translations);
  const members = [...new Set(input.memberIds)];
  if (members.length > PORTAL_ZONE_MAX_MEMBERS) throw new AppError('LOCATION_ZONE_TOO_LARGE');
  const known = await repo.existingLocationIds(tx, input.memberIds);
  if (input.memberIds.some((m) => !known.has(m))) throw new AppError('LOCATION_NOT_FOUND');
  const id = newId();
  await uniqueOr(
    () => repo.insertGroup(tx, { id, key: input.key }, input.translations, members),
    'LOCATION_ALIAS_TAKEN',
  );
  return changed(tx, 'locationGroup', id);
}

function toDto(row: Awaited<ReturnType<typeof repo.localized>>): LocationDto | null {
  return row ? { ...row, level: row.level as LocationLevel } : null;
}

/** The deepest location covering the point, or null. Uses the GiST index on the polygon. */
export async function findLocationAtPoint(ctx: Ctx, lon: number, lat: number): Promise<LocationDto | null> {
  assertCan(ctx, 'taxonomy.read');
  const id = await repo.deepestAt(ctx.tx, lon, lat);
  return id ? toDto(await repo.localized(ctx.tx, id, ctx.locale)) : null;
}

/** The canonical location for a feed spelling, or null (the caller queues it for mapping). */
export async function resolveLocationAlias(ctx: Ctx, spelling: string): Promise<LocationDto | null> {
  assertCan(ctx, 'taxonomy.read');
  const id = await repo.findByAliasKey(ctx.tx, aliasKey(spelling));
  return id ? toDto(await repo.localized(ctx.tx, id, ctx.locale)) : null;
}

// ---- Property types and features (S2-02) --------------------------------------------------------------------
// Reference data like locations: writes take the `tx` of a `withSystem()` call, reads take a tenant `ctx`.

async function createGroup(tx: Tx, kind: repo.CatalogKind, input: CreateTypeGroupInput): Promise<string> {
  assertContentLocales(input.translations);
  const id = newId();
  await uniqueOr(
    () => repo.insertCatalogGroup(tx, kind, { id, key: input.key, sort: input.sort }, input.translations),
    'TAXONOMY_KEY_TAKEN',
    'TAXONOMY_SLUG_TAKEN',
  );
  return changed(tx, `${kind}Group`, id);
}

async function createItem(
  tx: Tx,
  kind: repo.CatalogKind,
  input: CreatePropertyTypeInput,
  icon?: string,
): Promise<string> {
  assertContentLocales(input.translations);
  if (!(await repo.catalogGroupExists(tx, kind, input.groupId))) throw new AppError('TAXONOMY_NOT_FOUND');
  if (kind === 'propertyType' && (await repo.countCatalogItems(tx, kind, input.groupId)) >= PORTAL_MAX_SEARCH_TYPES) {
    throw new AppError('TAXONOMY_GROUP_TOO_LARGE');
  }
  const id = newId();
  await uniqueOr(
    () =>
      repo.insertCatalogItem(
        tx,
        kind,
        { id, groupId: input.groupId, key: input.key, sort: input.sort, ...(icon ? { icon } : {}) },
        input.translations,
      ),
    'TAXONOMY_KEY_TAKEN',
    'TAXONOMY_SLUG_TAKEN',
  );
  return changed(tx, kind, id);
}

async function addAlias(tx: Tx, kind: repo.CatalogKind, ownerId: string, alias: string): Promise<string> {
  if (!(await repo.catalogItemExists(tx, kind, ownerId))) throw new AppError('TAXONOMY_NOT_FOUND');
  const key = aliasKey(alias);
  if (!key) throw new AppError('VALIDATION_FAILED');
  const id = newId();
  await uniqueOr(
    () => repo.insertCatalogAlias(tx, kind, { id, ownerId, alias, aliasKey: key }),
    'TAXONOMY_ALIAS_TAKEN',
  );
  await repo.markUnmatchedMapped(tx, kind, key, ownerId);
  return changed(tx, `${kind}Alias`, id);
}

async function resolveAlias(ctx: Ctx, kind: repo.CatalogKind, spelling: string) {
  assertCan(ctx, 'taxonomy.read');
  const id = await repo.findCatalogByAliasKey(ctx.tx, kind, aliasKey(spelling));
  return id ? repo.localizedCatalogItem(ctx.tx, kind, id, ctx.locale) : null;
}

export const createPropertyTypeGroup = (tx: Tx, input: CreateTypeGroupInput) => createGroup(tx, 'propertyType', input);
export const createPropertyType = (tx: Tx, input: CreatePropertyTypeInput) => createItem(tx, 'propertyType', input);
export const addPropertyTypeAlias = (tx: Tx, typeId: string, alias: string) =>
  addAlias(tx, 'propertyType', typeId, alias);

export const createFeatureGroup = (tx: Tx, input: CreateTypeGroupInput) => createGroup(tx, 'feature', input);
export const createFeature = (tx: Tx, input: CreateFeatureInput) => createItem(tx, 'feature', input, input.icon);
export const addFeatureAlias = (tx: Tx, featureId: string, alias: string) => addAlias(tx, 'feature', featureId, alias);

/** The canonical property type for a feed spelling, or null (the caller queues it for mapping). */
export async function resolvePropertyTypeAlias(ctx: Ctx, spelling: string): Promise<PropertyTypeDto | null> {
  const row = await resolveAlias(ctx, 'propertyType', spelling);
  return row ? { id: row.id, groupId: row.groupId, key: row.key, name: row.name, slug: row.slug } : null;
}

/** The canonical feature (with its Lucide icon) for a feed spelling, or null. */
export async function resolveFeatureAlias(ctx: Ctx, spelling: string): Promise<FeatureDto | null> {
  const row = await resolveAlias(ctx, 'feature', spelling);
  return row
    ? { id: row.id, groupId: row.groupId, key: row.key, name: row.name, slug: row.slug, icon: row.icon ?? '' }
    : null;
}

/** A location's depth and its line (country, region, city, itself) by depth, or null; for listings (S3-F6). */
export const locationLineage = (tx: Tx, id: string) => repo.lineage(tx, id);

/** Whether a property type exists (crm's seller prospects keep one without a foreign key, S10-07). */
export const propertyTypeExists = (tx: Tx, id: string) => repo.propertyTypeExists(tx, id);

/** `locationLineage` for many locations at once (feed imports, S6-02): id → its and its ancestors' ids by depth. */
export const locationLineages = (tx: Tx, ids: readonly string[]) => repo.lineages(tx, ids);

/** Ancestors of each location (parent, grandparent, …); for imports that check a legacy parent (S2-06). */
export const locationAncestors = (tx: Tx, ids: string[]) => repo.locationAncestors(tx, ids);

const ALIAS_ENTITY = { location: 'locationAlias', propertyType: 'propertyTypeAlias', feature: 'featureAlias' } as const;

/**
 * Bulk alias write for imports (S2-06): one insert per 1,000 spellings, one queue update, one change event.
 * The owners must exist (callers pass resolver results). A spelling owned already is skipped and returned
 * with its owner, never an error, so one clash does not abort the import.
 */
export async function importAliases(
  tx: Tx,
  kind: repo.ResolveKind,
  rows: readonly { ownerId: string; alias: string }[],
): Promise<{ inserted: Set<string>; owners: Map<string, string> }> {
  const byKey = new Map<string, { id: string; ownerId: string; alias: string; aliasKey: string }>();
  for (const r of rows) {
    const key = aliasKey(r.alias);
    if (key && !byKey.has(key)) byKey.set(key, { id: newId(), ownerId: r.ownerId, alias: r.alias, aliasKey: key });
  }
  const result = await repo.insertAliasesBulk(tx, kind, [...byKey.values()]);
  const first = [...byKey.values()].find((r) => result.inserted.has(r.aliasKey));
  if (first) await changed(tx, ALIAS_ENTITY[kind], first.id);
  return result;
}
