/**
 * Staff taxonomy admin (S2-04, PLAN §7 M4): the editor behind `/v1/staff/taxonomy`. Use cases take a
 * `StaffCtx` (an `app_staff` transaction) and authorize with `staff.taxonomy.*`. The reference tables grant
 * `app_staff` DML (registry `staffWrite`, RLS gated by `app_is_staff()`), so the change, its
 * `taxonomy.data.changed` event (cache invalidation, feed re-mapping) and its audit row commit together.
 * No network call anywhere.
 */
import type {
  AddAliasInput,
  CreateLocationInput,
  ReorderCatalogInput,
  ReorderLocationsInput,
  StaffCatalogItemDto,
  StaffLocationDto,
  TaxonomyDto,
  UpdateCatalogItemInput,
  UpdateLocationInput,
} from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { DEFAULT_CONTENT_LOCALE, isContentLocale } from '@inmolink/i18n';
import { AppError } from '@inmolink/platform/errors';
import { emit } from '@inmolink/platform/outbox';
import type { StaffCtx } from '../../context';
import * as compliance from '../compliance';
import { taxonomyEvents } from './events';
import { assertStaffCan } from './policy';
import * as repo from './repo';
import { addFeatureAlias, addLocationAlias, addPropertyTypeAlias, changed, createLocation, uniqueOr } from './service';
import { loadTaxonomyFresh } from './tree';

/** Authorizes a write, runs it in the staff transaction and audits it. */
async function write<T>(ctx: StaffCtx, action: string, entity: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  assertStaffCan(ctx, 'staff.taxonomy.write');
  const result = await fn(ctx.tx);
  await compliance.auditStaff(ctx, null, 'staff.taxonomy.changed', null, { action, entity });
  return result;
}

/** Same ids, each once, in any order. */
const same = (current: string[], ordered: string[]) => {
  const known = new Set(current);
  return (
    known.size === ordered.length && new Set(ordered).size === ordered.length && ordered.every((id) => known.has(id))
  );
};

// ---- Reads ---------------------------------------------------------------------------------------------------

/** The whole localized tree in the staff member's locale, never cached (see `loadTaxonomyFresh`). */
export async function getStaffTaxonomy(ctx: StaffCtx): Promise<TaxonomyDto> {
  assertStaffCan(ctx, 'staff.taxonomy.read');
  return loadTaxonomyFresh(ctx.tx, isContentLocale(ctx.locale) ? ctx.locale : DEFAULT_CONTENT_LOCALE);
}

export async function getStaffLocation(ctx: StaffCtx, id: string): Promise<StaffLocationDto> {
  assertStaffCan(ctx, 'staff.taxonomy.read');
  const row = await repo.locationDetail(ctx.tx, id);
  if (!row) throw new AppError('LOCATION_NOT_FOUND');
  return row as StaffLocationDto;
}

export async function getStaffCatalogItem(
  ctx: StaffCtx,
  kind: StaffCatalogItemDto['kind'],
  scope: StaffCatalogItemDto['scope'],
  id: string,
): Promise<StaffCatalogItemDto> {
  assertStaffCan(ctx, 'staff.taxonomy.read');
  const row = await repo.catalogDetail(ctx.tx, kind, scope, id);
  if (!row) throw new AppError('TAXONOMY_NOT_FOUND');
  return { id, kind, scope, ...row };
}

// ---- Locations -----------------------------------------------------------------------------------------------

/** Creates a location (last among its siblings) and returns it. */
export async function createStaffLocation(ctx: StaffCtx, input: CreateLocationInput): Promise<StaffLocationDto> {
  const id = await write(ctx, 'createLocation', 'location', async (tx) => {
    const created = await createLocation(tx, input);
    await repo.setLocationSort(tx, created, await repo.nextLocationSort(tx, input.parentId));
    return created;
  });
  return getStaffLocation(ctx, id);
}

/** Changes the fields that were sent. A polygon must be valid; a slug must stay unique per parent and locale. */
export async function updateStaffLocation(
  ctx: StaffCtx,
  id: string,
  input: UpdateLocationInput,
): Promise<StaffLocationDto> {
  await write(ctx, 'updateLocation', 'location', async (tx) => {
    const parent = await repo.locationParent(tx, id);
    if (!parent) throw new AppError('LOCATION_NOT_FOUND');
    const polygonGeoJson = input.polygon === undefined ? undefined : input.polygon && JSON.stringify(input.polygon);
    if (polygonGeoJson && !(await repo.polygonValid(tx, polygonGeoJson)))
      throw new AppError('LOCATION_POLYGON_INVALID');
    await uniqueOr(async () => {
      if (input.translations) await repo.replaceLocationTranslations(tx, id, parent.parentId, input.translations);
      await repo.updateLocationFields(tx, id, {
        ...(input.code !== undefined ? { code: input.code } : {}),
        ...(input.centroid !== undefined ? { centroidGeoJson: input.centroid && JSON.stringify(input.centroid) } : {}),
        ...(polygonGeoJson !== undefined ? { polygonGeoJson } : {}),
      });
    }, 'LOCATION_SLUG_TAKEN');
    return changed(tx, 'location', id);
  });
  return getStaffLocation(ctx, id);
}

/** Drag-and-drop: `orderedIds` must be exactly the children of the parent, in their new order. */
export async function reorderStaffLocations(ctx: StaffCtx, input: ReorderLocationsInput): Promise<void> {
  await write(ctx, 'reorderLocations', 'location', async (tx) => {
    const siblings = await repo.lockedSiblingIds(tx, input.parentId);
    if (!same(siblings, input.orderedIds)) throw new AppError('TAXONOMY_ORDER_INVALID');
    await repo.setLocationSorts(tx, input.orderedIds);
    return changed(tx, 'location', input.orderedIds[0] as string);
  });
}

export async function addStaffLocationAlias(
  ctx: StaffCtx,
  id: string,
  input: AddAliasInput,
): Promise<StaffLocationDto> {
  await write(ctx, 'addLocationAlias', 'locationAlias', (tx) => addLocationAlias(tx, id, input.alias));
  return getStaffLocation(ctx, id);
}

export async function removeStaffLocationAlias(ctx: StaffCtx, id: string, aliasId: string): Promise<StaffLocationDto> {
  await write(ctx, 'removeLocationAlias', 'locationAlias', async (tx) => {
    if (!(await repo.deleteLocationAlias(tx, id, aliasId))) throw new AppError('LOCATION_NOT_FOUND');
    await emit(tx, taxonomyEvents.changed({ entity: 'locationAlias', id: aliasId }));
  });
  return getStaffLocation(ctx, id);
}

// ---- Property types and features ---------------------------------------------------------------------------

export async function reorderStaffCatalog(ctx: StaffCtx, input: ReorderCatalogInput): Promise<void> {
  await write(ctx, 'reorderCatalog', input.kind, async (tx) => {
    if (input.groupId !== null && !(await repo.catalogGroupExists(tx, input.kind, input.groupId))) {
      throw new AppError('TAXONOMY_NOT_FOUND');
    }
    const current = await repo.lockedCatalogIds(tx, input.kind, input.groupId);
    if (!same(current, input.orderedIds)) throw new AppError('TAXONOMY_ORDER_INVALID');
    await repo.setCatalogSorts(tx, input.kind, input.groupId, input.orderedIds);
    return changed(tx, input.groupId === null ? `${input.kind}Group` : input.kind, input.orderedIds[0] as string);
  });
}

export async function updateStaffCatalogItem(
  ctx: StaffCtx,
  id: string,
  input: UpdateCatalogItemInput,
): Promise<StaffCatalogItemDto> {
  await write(ctx, 'updateCatalogItem', input.kind, async (tx) => {
    const found = await uniqueOr(
      () => repo.replaceCatalogTranslations(tx, input.kind, input.scope, id, input.translations),
      'TAXONOMY_KEY_TAKEN',
    );
    if (!found) throw new AppError('TAXONOMY_NOT_FOUND');
    return changed(tx, input.scope === 'group' ? `${input.kind}Group` : input.kind, id);
  });
  return getStaffCatalogItem(ctx, input.kind, input.scope, id);
}

export async function addStaffCatalogAlias(
  ctx: StaffCtx,
  kind: StaffCatalogItemDto['kind'],
  id: string,
  input: AddAliasInput,
): Promise<StaffCatalogItemDto> {
  await write(ctx, 'addCatalogAlias', kind, (tx) =>
    kind === 'feature' ? addFeatureAlias(tx, id, input.alias) : addPropertyTypeAlias(tx, id, input.alias),
  );
  return getStaffCatalogItem(ctx, kind, 'item', id);
}

export async function removeStaffCatalogAlias(
  ctx: StaffCtx,
  kind: StaffCatalogItemDto['kind'],
  id: string,
  aliasId: string,
): Promise<StaffCatalogItemDto> {
  await write(ctx, 'removeCatalogAlias', kind, async (tx) => {
    if (!(await repo.deleteCatalogAlias(tx, kind, id, aliasId))) throw new AppError('TAXONOMY_NOT_FOUND');
    await emit(tx, taxonomyEvents.changed({ entity: `${kind}Alias`, id: aliasId }));
  });
  return getStaffCatalogItem(ctx, kind, 'item', id);
}
