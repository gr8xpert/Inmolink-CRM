import {
  type AddAliasInput,
  type CreateLocationInput,
  type ReorderCatalogInput,
  type ReorderLocationsInput,
  StaffCatalogItemDto,
  StaffLocationChildrenDto,
  StaffLocationDto,
  StaffTaxonomyDto,
  type UpdateCatalogItemInput,
  type UpdateLocationInput,
} from '@inmolink/contracts';
import { z } from 'zod';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/**
 * Staff taxonomy editor calls (S2-04, transport only). All under `/v1/staff/taxonomy`, so the token is the
 * staff member's own; the API decides who may write and audits every change.
 */
const base = '/v1/staff/taxonomy';
const seg = encodeURIComponent;

export const fetchStaffTaxonomy = (s: SessionRef): Promise<ApiResult<StaffTaxonomyDto>> =>
  apiRequest(s, base, StaffTaxonomyDto);

export const fetchStaffLocationChildren = (s: SessionRef, id: string): Promise<ApiResult<StaffLocationChildrenDto>> =>
  apiRequest(s, `${base}/locations/${seg(id)}/children`, StaffLocationChildrenDto);

export const fetchStaffLocation = (s: SessionRef, id: string): Promise<ApiResult<StaffLocationDto>> =>
  apiRequest(s, `${base}/locations/${seg(id)}`, StaffLocationDto);

export const createStaffLocation = (s: SessionRef, body: CreateLocationInput): Promise<ApiResult<StaffLocationDto>> =>
  apiRequest(s, `${base}/locations`, StaffLocationDto, { method: 'POST', body });

export const updateStaffLocation = (
  s: SessionRef,
  id: string,
  body: UpdateLocationInput,
): Promise<ApiResult<StaffLocationDto>> =>
  apiRequest(s, `${base}/locations/${seg(id)}`, StaffLocationDto, { method: 'PATCH', body, timeoutMs: 15_000 });

export const reorderStaffLocations = (s: SessionRef, body: ReorderLocationsInput): Promise<ApiResult<null>> =>
  apiRequest(s, `${base}/locations-order`, z.null(), { method: 'PUT', body });

export const addStaffLocationAlias = (
  s: SessionRef,
  id: string,
  body: AddAliasInput,
): Promise<ApiResult<StaffLocationDto>> =>
  apiRequest(s, `${base}/locations/${seg(id)}/aliases`, StaffLocationDto, { method: 'POST', body });

export const removeStaffLocationAlias = (
  s: SessionRef,
  id: string,
  aliasId: string,
): Promise<ApiResult<StaffLocationDto>> =>
  apiRequest(s, `${base}/locations/${seg(id)}/aliases/${seg(aliasId)}`, StaffLocationDto, { method: 'DELETE' });

export const fetchStaffCatalogItem = (
  s: SessionRef,
  kind: string,
  scope: string,
  id: string,
): Promise<ApiResult<StaffCatalogItemDto>> =>
  apiRequest(s, `${base}/catalog/${seg(kind)}/${seg(scope)}/${seg(id)}`, StaffCatalogItemDto);

export const updateStaffCatalogItem = (
  s: SessionRef,
  id: string,
  body: UpdateCatalogItemInput,
): Promise<ApiResult<StaffCatalogItemDto>> =>
  apiRequest(s, `${base}/catalog/${seg(id)}`, StaffCatalogItemDto, { method: 'PUT', body });

export const reorderStaffCatalog = (s: SessionRef, body: ReorderCatalogInput): Promise<ApiResult<null>> =>
  apiRequest(s, `${base}/catalog-order`, z.null(), { method: 'PUT', body });

export const addStaffCatalogAlias = (
  s: SessionRef,
  kind: string,
  id: string,
  body: AddAliasInput,
): Promise<ApiResult<StaffCatalogItemDto>> =>
  apiRequest(s, `${base}/catalog/${seg(kind)}/${seg(id)}/aliases`, StaffCatalogItemDto, { method: 'POST', body });

export const removeStaffCatalogAlias = (
  s: SessionRef,
  kind: string,
  id: string,
  aliasId: string,
): Promise<ApiResult<StaffCatalogItemDto>> =>
  apiRequest(s, `${base}/catalog/${seg(kind)}/${seg(id)}/aliases/${seg(aliasId)}`, StaffCatalogItemDto, {
    method: 'DELETE',
  });
