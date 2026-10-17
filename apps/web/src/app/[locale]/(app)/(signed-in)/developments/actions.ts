'use server';

import {
  BulkUpdateUnitsBody,
  CreateDevelopmentBody,
  CreatePriceListBody,
  CreateUnitsBody,
  type DevelopmentDocumentDto,
  type DevelopmentDocumentList,
  type DevelopmentDocumentUrlDto,
  type DevelopmentDto,
  type PriceListDto,
  SetDevelopmentAccessBody,
  type UnitDto,
  type UnitList,
  type UnitPage,
  UnitStatus,
  UpdateDevelopmentBody,
  UpdateDevelopmentDocumentBody,
  UpdateUnitBody,
} from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import {
  type ApiResult,
  approvePriceList,
  bulkUpdateUnits,
  createDevelopment,
  createPriceList,
  createUnits,
  deleteDevelopmentDocument,
  deleteUnit,
  fetchDevelopmentDocuments,
  fetchPriceList,
  fetchUnits,
  openDevelopmentDocument,
  type SessionRef,
  sessionRef,
  setDevelopmentAccess,
  updateDevelopment,
  updateDevelopmentDocument,
  updateUnit,
} from '@/server/api';

/**
 * Development page actions (S4-03, transport only): validate with the contract, call the API, hand back the
 * result — or the error code and the fields it names, which the panels show as messages.
 */
export type DevResult<T> = { ok: true; data: T } | { ok: false; code: string; fields: string[]; revoked?: boolean };

const Uuid = z.uuid();
const issuePaths = (issues: { path: PropertyKey[] }[]) => [...new Set(issues.map((i) => i.path.map(String).join('.')))];
const invalid = (fields: string[]): DevResult<never> => ({ ok: false, code: 'VALIDATION_FAILED', fields });
const badId = () => invalid(['id']);

async function withSession<T>(call: (s: SessionRef) => Promise<ApiResult<T>>): Promise<DevResult<T>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, code: 'SESSION_REVOKED', fields: [], revoked: true };
  const res = await call(sessionRef(session.user));
  if (res === 'revoked') return { ok: false, code: 'SESSION_REVOKED', fields: [], revoked: true };
  if (res.ok) return { ok: true, data: res.data };
  const field = (res.error?.details as { field?: unknown } | undefined)?.field;
  return {
    ok: false,
    code: res.error?.code ?? (res.status === 0 ? 'NETWORK' : 'INTERNAL'),
    fields: typeof field === 'string' ? [field] : [],
  };
}

export interface CreateState {
  code?: string;
  fields?: string[];
  revoked?: boolean;
}

/** New development: a plain form posting here; on success the development page takes over. */
export async function createDevelopmentAction(_prev: CreateState, form: FormData): Promise<CreateState> {
  const parsed = CreateDevelopmentBody.safeParse({
    ref: form.get('ref'),
    name: form.get('name'),
    locationId: form.get('locationId'),
    status: form.get('status') || undefined,
    currency: form.get('currency') || undefined,
  });
  if (!parsed.success) return { code: 'VALIDATION_FAILED', fields: issuePaths(parsed.error.issues) };
  const res = await withSession((s) => createDevelopment(s, parsed.data));
  if (!res.ok) return { code: res.code, fields: res.fields, ...(res.revoked ? { revoked: true } : {}) };
  redirect(getPathname({ href: `/developments/${res.data.id}`, locale: await getLocale() }));
}

export async function saveDevelopmentAction(id: string, body: unknown): Promise<DevResult<DevelopmentDto>> {
  if (!Uuid.safeParse(id).success) return badId();
  const parsed = UpdateDevelopmentBody.safeParse(body);
  if (!parsed.success) return invalid(issuePaths(parsed.error.issues));
  return withSession((s) => updateDevelopment(s, id, parsed.data));
}

export async function saveAccessAction(id: string, body: unknown): Promise<DevResult<DevelopmentDto>> {
  if (!Uuid.safeParse(id).success) return badId();
  const parsed = SetDevelopmentAccessBody.safeParse(body);
  if (!parsed.success) return invalid(issuePaths(parsed.error.issues));
  return withSession((s) => setDevelopmentAccess(s, id, parsed.data));
}

export async function unitsPageAction(
  id: string,
  cursor: string | null,
  status: unknown,
): Promise<DevResult<UnitPage>> {
  if (!Uuid.safeParse(id).success) return badId();
  const st = status === null || status === '' ? undefined : UnitStatus.safeParse(status);
  if (st && !st.success) return invalid(['status']);
  return withSession((s) => fetchUnits(s, id, { ...(cursor ? { cursor } : {}), ...(st ? { status: st.data } : {}) }));
}

export async function createUnitsAction(id: string, body: unknown): Promise<DevResult<UnitList>> {
  if (!Uuid.safeParse(id).success) return badId();
  const parsed = CreateUnitsBody.safeParse(body);
  if (!parsed.success) return invalid(issuePaths(parsed.error.issues));
  return withSession((s) => createUnits(s, id, parsed.data));
}

export async function saveUnitAction(id: string, unitId: string, body: unknown): Promise<DevResult<UnitDto>> {
  if (!Uuid.safeParse(id).success || !Uuid.safeParse(unitId).success) return badId();
  const parsed = UpdateUnitBody.safeParse(body);
  if (!parsed.success) return invalid(issuePaths(parsed.error.issues));
  return withSession((s) => updateUnit(s, id, unitId, parsed.data));
}

export async function bulkUnitsAction(id: string, body: unknown): Promise<DevResult<UnitList>> {
  if (!Uuid.safeParse(id).success) return badId();
  const parsed = BulkUpdateUnitsBody.safeParse(body);
  if (!parsed.success) return invalid(issuePaths(parsed.error.issues));
  return withSession((s) => bulkUpdateUnits(s, id, parsed.data));
}

export async function deleteUnitAction(id: string, unitId: string): Promise<DevResult<null>> {
  if (!Uuid.safeParse(id).success || !Uuid.safeParse(unitId).success) return badId();
  return withSession((s) => deleteUnit(s, id, unitId));
}

export async function createPriceListAction(id: string, body: unknown): Promise<DevResult<PriceListDto>> {
  if (!Uuid.safeParse(id).success) return badId();
  const parsed = CreatePriceListBody.safeParse(body);
  if (!parsed.success) return invalid(issuePaths(parsed.error.issues));
  return withSession((s) => createPriceList(s, id, parsed.data));
}

/** One version's full diff, when the person opens it (S4-F5). */
export async function getPriceListAction(id: string, version: number): Promise<DevResult<PriceListDto>> {
  if (!Uuid.safeParse(id).success || !Number.isInteger(version) || version < 1) return badId();
  return withSession((s) => fetchPriceList(s, id, version));
}

export async function approvePriceListAction(id: string, version: number): Promise<DevResult<PriceListDto>> {
  if (!Uuid.safeParse(id).success || !Number.isInteger(version) || version < 1) return badId();
  return withSession((s) => approvePriceList(s, id, version));
}

/** A short signed download URL of one development document (S4-F4). */
export async function openDocumentAction(
  id: string,
  documentId: string,
): Promise<DevResult<DevelopmentDocumentUrlDto>> {
  if (!Uuid.safeParse(id).success || !Uuid.safeParse(documentId).success) return badId();
  return withSession((s) => openDevelopmentDocument(s, id, documentId));
}

/** A document's kind or shared flag. */
export async function updateDocumentAction(
  id: string,
  documentId: string,
  body: unknown,
): Promise<DevResult<DevelopmentDocumentDto>> {
  if (!Uuid.safeParse(id).success || !Uuid.safeParse(documentId).success) return badId();
  const parsed = UpdateDevelopmentDocumentBody.safeParse(body);
  if (!parsed.success) return invalid(issuePaths(parsed.error.issues));
  return withSession((s) => updateDevelopmentDocument(s, id, documentId, parsed.data));
}

/** Removes a document; answers the documents left. */
export async function deleteDocumentAction(
  id: string,
  documentId: string,
): Promise<DevResult<DevelopmentDocumentList>> {
  if (!Uuid.safeParse(id).success || !Uuid.safeParse(documentId).success) return badId();
  const removed = await withSession((s) => deleteDevelopmentDocument(s, id, documentId));
  if (!removed.ok) return removed;
  return withSession((s) => fetchDevelopmentDocuments(s, id));
}
