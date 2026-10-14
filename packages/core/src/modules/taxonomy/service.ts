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
import type { Tx } from '@inmolink/db';
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
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code;
}

export async function uniqueOr<T>(
  fn: () => Promise<T>,
  code: 'LOCATION_SLUG_TAKEN' | 'LOCATION_ALIAS_TAKEN' | 'TAXONOMY_KEY_TAKEN' | 'TAXONOMY_ALIAS_TAKEN',
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (pgCode(err) === '23505') throw new AppError(code);
    throw err;
  }
}

/** Every write ends here: same transaction, so the event exists if and only if the write commits. */
export async function changed(tx: Tx, entity: TaxonomyEntity, id: string): Promise<string> {
  await emit(tx, taxonomyEvents.changed({ entity, id }));
  return id;
}

/** Creates a location with its translations. The parent must be exactly one level above. */
export async function createLocation(tx: Tx, input: CreateLocationInput): Promise<string> {
  const depth = DEPTH[input.level];
  if (input.parentId === null) {
    if (depth !== 1) throw new AppError('LOCATION_PARENT_INVALID');
  } else {
    const parentDepth = await repo.getDepth(tx, input.parentId);
    if (parentDepth === null || parentDepth !== depth - 1) throw new AppError('LOCATION_PARENT_INVALID');
  }
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
          polygonGeoJson: input.polygon ? JSON.stringify(input.polygon) : null,
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
  const known = await repo.existingLocationIds(tx, input.memberIds);
  if (input.memberIds.some((m) => !known.has(m))) throw new AppError('LOCATION_NOT_FOUND');
  const id = newId();
  await uniqueOr(
    () => repo.insertGroup(tx, { id, key: input.key }, input.translations, [...new Set(input.memberIds)]),
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
  const id = newId();
  await uniqueOr(
    () => repo.insertCatalogGroup(tx, kind, { id, key: input.key, sort: input.sort }, input.translations),
    'TAXONOMY_KEY_TAKEN',
  );
  return changed(tx, `${kind}Group`, id);
}

async function createItem(
  tx: Tx,
  kind: repo.CatalogKind,
  input: CreatePropertyTypeInput,
  icon?: string,
): Promise<string> {
  if (!(await repo.catalogGroupExists(tx, kind, input.groupId))) throw new AppError('TAXONOMY_NOT_FOUND');
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
