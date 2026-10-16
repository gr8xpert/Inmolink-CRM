'use server';

import {
  AddAliasInput,
  CreateLocationInput,
  ReorderCatalogInput,
  ReorderLocationsInput,
  type StaffCatalogItemDto,
  type StaffLocationChildrenDto,
  type StaffLocationDto,
  UpdateCatalogItemInput,
  UpdateLocationInput,
} from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { auth } from '@/auth';
import { type ApiResult, sessionRef } from '@/server/api';
import * as api from '@/server/staff-taxonomy';

/**
 * Taxonomy editor actions (S2-04, transport only). The client component calls them with plain objects; each is
 * validated with the contract schema and forwarded to `/v1/staff/taxonomy`. The API authorizes (403 for support
 * staff), audits and emits the change event. Errors come back as the API's code, shown under `staff.taxonomy.errors`.
 */
export type ActionResult<T = null> = { ok: true; data: T } | { ok: false; error: string };

const Id = z.uuid();
const Kind = z.enum(['propertyType', 'feature']);

async function session() {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  return sessionRef(s.user);
}

function settle<T>(res: ApiResult<T>): ActionResult<T> {
  if (res === 'revoked') redirect('/session/expired');
  return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error?.code ?? 'generic' };
}

const invalid = { ok: false, error: 'VALIDATION_FAILED' } as const;

export async function loadLocationAction(id: unknown): Promise<ActionResult<StaffLocationDto>> {
  const parsed = Id.safeParse(id);
  if (!parsed.success) return invalid;
  return settle(await api.fetchStaffLocation(await session(), parsed.data));
}

/** A region's cities or a city's areas, loaded when the editor expands it (S3-F2). */
export async function loadLocationChildrenAction(id: unknown): Promise<ActionResult<StaffLocationChildrenDto>> {
  const parsed = Id.safeParse(id);
  if (!parsed.success) return invalid;
  return settle(await api.fetchStaffLocationChildren(await session(), parsed.data));
}

export async function createLocationAction(input: unknown): Promise<ActionResult<StaffLocationDto>> {
  const parsed = CreateLocationInput.safeParse(input);
  if (!parsed.success) return invalid;
  return settle(await api.createStaffLocation(await session(), parsed.data));
}

export async function updateLocationAction(id: unknown, input: unknown): Promise<ActionResult<StaffLocationDto>> {
  const parsedId = Id.safeParse(id);
  const parsed = UpdateLocationInput.safeParse(input);
  if (!parsedId.success || !parsed.success) return invalid;
  return settle(await api.updateStaffLocation(await session(), parsedId.data, parsed.data));
}

export async function reorderLocationsAction(input: unknown): Promise<ActionResult> {
  const parsed = ReorderLocationsInput.safeParse(input);
  if (!parsed.success) return invalid;
  return settle(await api.reorderStaffLocations(await session(), parsed.data));
}

export async function addLocationAliasAction(id: unknown, input: unknown): Promise<ActionResult<StaffLocationDto>> {
  const parsedId = Id.safeParse(id);
  const parsed = AddAliasInput.safeParse(input);
  if (!parsedId.success || !parsed.success) return invalid;
  return settle(await api.addStaffLocationAlias(await session(), parsedId.data, parsed.data));
}

export async function removeLocationAliasAction(
  id: unknown,
  aliasId: unknown,
): Promise<ActionResult<StaffLocationDto>> {
  const a = Id.safeParse(id);
  const b = Id.safeParse(aliasId);
  if (!a.success || !b.success) return invalid;
  return settle(await api.removeStaffLocationAlias(await session(), a.data, b.data));
}

export async function loadCatalogItemAction(
  kind: unknown,
  scope: unknown,
  id: unknown,
): Promise<ActionResult<StaffCatalogItemDto>> {
  const k = Kind.safeParse(kind);
  const s = z.enum(['group', 'item']).safeParse(scope);
  const i = Id.safeParse(id);
  if (!k.success || !s.success || !i.success) return invalid;
  return settle(await api.fetchStaffCatalogItem(await session(), k.data, s.data, i.data));
}

export async function updateCatalogItemAction(id: unknown, input: unknown): Promise<ActionResult<StaffCatalogItemDto>> {
  const i = Id.safeParse(id);
  const parsed = UpdateCatalogItemInput.safeParse(input);
  if (!i.success || !parsed.success) return invalid;
  return settle(await api.updateStaffCatalogItem(await session(), i.data, parsed.data));
}

export async function reorderCatalogAction(input: unknown): Promise<ActionResult> {
  const parsed = ReorderCatalogInput.safeParse(input);
  if (!parsed.success) return invalid;
  return settle(await api.reorderStaffCatalog(await session(), parsed.data));
}

export async function addCatalogAliasAction(
  kind: unknown,
  id: unknown,
  input: unknown,
): Promise<ActionResult<StaffCatalogItemDto>> {
  const k = Kind.safeParse(kind);
  const i = Id.safeParse(id);
  const parsed = AddAliasInput.safeParse(input);
  if (!k.success || !i.success || !parsed.success) return invalid;
  return settle(await api.addStaffCatalogAlias(await session(), k.data, i.data, parsed.data));
}

export async function removeCatalogAliasAction(
  kind: unknown,
  id: unknown,
  aliasId: unknown,
): Promise<ActionResult<StaffCatalogItemDto>> {
  const k = Kind.safeParse(kind);
  const i = Id.safeParse(id);
  const a = Id.safeParse(aliasId);
  if (!k.success || !i.success || !a.success) return invalid;
  return settle(await api.removeStaffCatalogAlias(await session(), k.data, i.data, a.data));
}
