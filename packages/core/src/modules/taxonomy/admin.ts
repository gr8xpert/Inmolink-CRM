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
  MapUnmatchedInput,
  ReorderCatalogInput,
  ReorderLocationsInput,
  StaffCatalogItemDto,
  StaffLocationChildrenDto,
  StaffLocationDto,
  StaffTaxonomyDto,
  UnmatchedDto,
  UnmatchedListQuery,
  UnmatchedPageDto,
  UpdateCatalogItemInput,
  UpdateLocationInput,
} from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { DEFAULT_CONTENT_LOCALE, isContentLocale } from '@inmolink/i18n';
import { AppError } from '@inmolink/platform/errors';
import { emit } from '@inmolink/platform/outbox';
import { z } from 'zod';
import type { StaffCtx } from '../../context';
import * as compliance from '../compliance';
import { taxonomyEvents } from './events';
import { assertStaffCan } from './policy';
import * as repo from './repo';
import {
  addFeatureAlias,
  addLocationAlias,
  addPropertyTypeAlias,
  assertContentLocales,
  changed,
  createLocation,
  uniqueOr,
} from './service';
import { loadStaffChildren, loadStaffTop } from './tree';

/**
 * Authorizes a write, runs it in the staff transaction and audits it. The audit row names the changed entity
 * (S3-F1): `id`, or else the id `fn` returns (a created row, a new alias).
 */
async function write<T>(
  ctx: StaffCtx,
  action: string,
  entity: string,
  id: string | null,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  assertStaffCan(ctx, 'staff.taxonomy.write');
  const result = await fn(ctx.tx);
  const entityId = id ?? (typeof result === 'string' ? result : null);
  await compliance.auditStaff(
    ctx,
    null,
    'staff.taxonomy.changed',
    entityId ? { type: 'taxonomy', id: entityId } : null,
    { action, entity, entityId },
  );
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

const staffLocale = (ctx: StaffCtx) => (isContentLocale(ctx.locale) ? ctx.locale : DEFAULT_CONTENT_LOCALE);

/** Countries, regions, groups and the catalog in the staff member's locale, never cached (see `loadStaffTop`). */
export async function getStaffTaxonomy(ctx: StaffCtx): Promise<StaffTaxonomyDto> {
  assertStaffCan(ctx, 'staff.taxonomy.read');
  return loadStaffTop(ctx.tx, staffLocale(ctx));
}

/** A location's direct children, never cached: the editor expands one region or city at a time (S3-F2). */
export async function getStaffLocationChildren(ctx: StaffCtx, id: string): Promise<StaffLocationChildrenDto> {
  assertStaffCan(ctx, 'staff.taxonomy.read');
  if (!(await repo.locationParent(ctx.tx, id))) throw new AppError('LOCATION_NOT_FOUND');
  return { parentId: id, children: await loadStaffChildren(ctx.tx, id, staffLocale(ctx)) };
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
  const id = await write(ctx, 'createLocation', 'location', null, async (tx) => {
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
  await write(ctx, 'updateLocation', 'location', id, async (tx) => {
    assertContentLocales(input.translations);
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
  await write(ctx, 'reorderLocations', 'location', input.parentId, async (tx) => {
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
  await write(ctx, 'addLocationAlias', 'locationAlias', null, (tx) => addLocationAlias(tx, id, input.alias));
  return getStaffLocation(ctx, id);
}

export async function removeStaffLocationAlias(ctx: StaffCtx, id: string, aliasId: string): Promise<StaffLocationDto> {
  await write(ctx, 'removeLocationAlias', 'locationAlias', aliasId, async (tx) => {
    if (!(await repo.deleteLocationAlias(tx, id, aliasId))) throw new AppError('LOCATION_NOT_FOUND');
    await emit(tx, taxonomyEvents.changed({ entity: 'locationAlias', id: aliasId }));
  });
  return getStaffLocation(ctx, id);
}

// ---- Property types and features ---------------------------------------------------------------------------

export async function reorderStaffCatalog(ctx: StaffCtx, input: ReorderCatalogInput): Promise<void> {
  await write(ctx, 'reorderCatalog', input.kind, input.groupId, async (tx) => {
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
  await write(ctx, 'updateCatalogItem', input.kind, id, async (tx) => {
    assertContentLocales(input.translations);
    const found = await uniqueOr(
      () => repo.replaceCatalogTranslations(tx, input.kind, input.scope, id, input.translations),
      'TAXONOMY_KEY_TAKEN',
      'TAXONOMY_SLUG_TAKEN',
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
  await write(ctx, 'addCatalogAlias', kind, null, (tx) =>
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
  await write(ctx, 'removeCatalogAlias', kind, aliasId, async (tx) => {
    if (!(await repo.deleteCatalogAlias(tx, kind, id, aliasId))) throw new AppError('TAXONOMY_NOT_FOUND');
    await emit(tx, taxonomyEvents.changed({ entity: `${kind}Alias`, id: aliasId }));
  });
  return getStaffCatalogItem(ctx, kind, 'item', id);
}

// ---- Unmatched feed values (S2-05) ---------------------------------------------------------------------------

type Cursor = { count: number; id: string };
const encodeCursor = (c: Cursor) => Buffer.from(`${c.count}:${c.id}`).toString('base64url');
function decodeCursor(raw: string): Cursor {
  const [count, id] = Buffer.from(raw, 'base64url').toString().split(':');
  if (!/^\d+$/.test(count ?? '') || !id || !z.uuid().safeParse(id).success) throw new AppError('VALIDATION_FAILED');
  return { count: Number(count), id };
}

async function toUnmatchedDtos(ctx: StaffCtx, rows: repo.UnmatchedRow[]): Promise<UnmatchedDto[]> {
  const locale = isContentLocale(ctx.locale) ? ctx.locale : DEFAULT_CONTENT_LOCALE;
  const names = new Map<string, Map<string, string>>();
  for (const kind of ['location', 'propertyType', 'feature'] as const) {
    const ids = rows.filter((r) => r.kind === kind && r.candidateId).map((r) => r.candidateId as string);
    names.set(kind, await repo.ownerNames(ctx.tx, kind, [...new Set(ids)], locale));
  }
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as UnmatchedDto['kind'],
    value: r.value,
    count: r.count,
    examples: r.examples,
    candidate:
      r.candidateId && names.get(r.kind)?.has(r.candidateId)
        ? {
            id: r.candidateId,
            name: names.get(r.kind)?.get(r.candidateId) as string,
            confidence: r.candidateScore ?? 0,
          }
        : null,
    status: r.status as UnmatchedDto['status'],
    mappedToId: r.mappedToId,
    firstSeenAt: r.firstSeenAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
  }));
}

/** The queue, most-seen value first, cursor-paginated. Three statements at most (rows, then candidate names). */
export async function listStaffUnmatched(ctx: StaffCtx, query: UnmatchedListQuery): Promise<UnmatchedPageDto> {
  assertStaffCan(ctx, 'staff.taxonomy.read');
  const rows = await repo.listUnmatched(ctx.tx, {
    status: query.status,
    limit: query.limit,
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.cursor ? { after: decodeCursor(query.cursor) } : {}),
  });
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: await toUnmatchedDtos(ctx, page),
    nextCursor: rows.length > query.limit && last ? encodeCursor({ count: last.count, id: last.id }) : null,
  };
}

async function oneUnmatched(ctx: StaffCtx, id: string): Promise<UnmatchedDto> {
  const row = await repo.getUnmatched(ctx.tx, id);
  if (!row) throw new AppError('TAXONOMY_NOT_FOUND');
  return (await toUnmatchedDtos(ctx, [row]))[0] as UnmatchedDto;
}

/**
 * Maps a queued value to a location, property type or feature: the spelling becomes an alias (so the next
 * import resolves it exactly and promotes the drafts that waited on it) and the row closes as MAPPED.
 */
export async function mapStaffUnmatched(ctx: StaffCtx, id: string, input: MapUnmatchedInput): Promise<UnmatchedDto> {
  await write(ctx, 'mapUnmatched', 'unmatched', id, async (tx) => {
    const row = await repo.getUnmatched(tx, id);
    if (!row) throw new AppError('TAXONOMY_NOT_FOUND');
    if (row.status === 'MAPPED') return;
    const kind = row.kind as repo.ResolveKind;
    // Already this target's alias (an import reopened the row, or the alias came in another way): just close it.
    if ((await repo.aliasOwner(tx, kind, row.valueKey)) === input.targetId) {
      await repo.markUnmatchedMapped(tx, kind, row.valueKey, input.targetId);
      return;
    }
    if (row.kind === 'location') await addLocationAlias(tx, input.targetId, row.value);
    else if (row.kind === 'feature') await addFeatureAlias(tx, input.targetId, row.value);
    else await addPropertyTypeAlias(tx, input.targetId, row.value);
  });
  return oneUnmatched(ctx, id);
}

/**
 * Not worth mapping (noise in a feed): hidden from the open queue; counted again if it keeps coming. Only an
 * OPEN value can be ignored; a MAPPED one keeps its alias and status.
 */
export async function ignoreStaffUnmatched(ctx: StaffCtx, id: string): Promise<UnmatchedDto> {
  await write(ctx, 'ignoreUnmatched', 'unmatched', id, async (tx) => {
    const row = await repo.getUnmatched(tx, id);
    if (!row) throw new AppError('TAXONOMY_NOT_FOUND');
    if (row.status === 'OPEN') await repo.setUnmatchedIgnored(tx, id);
  });
  return oneUnmatched(ctx, id);
}
