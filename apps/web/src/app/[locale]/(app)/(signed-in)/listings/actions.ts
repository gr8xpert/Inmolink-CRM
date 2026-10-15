'use server';

import {
  CreateListingBody,
  type ListingContentDto,
  type ListingDto,
  PutListingTranslationBody,
  SetListingFeaturesBody,
  UpdateListingBody,
} from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import {
  type ApiResult,
  createListing,
  deleteListingTranslation,
  putListingTranslation,
  type SessionRef,
  sessionRef,
  setListingFeatures,
  updateListing,
} from '@/server/api';
import { inputOf } from './values';

/**
 * Listing editor actions (S3-05, transport only): validate with the contract, call the API, hand back the saved
 * listing or content — or the error code and the fields it names, which the editor shows as messages.
 */
export type EditorResult<T> = { ok: true; data: T } | { ok: false; code: string; fields: string[]; revoked?: boolean };

const invalid = (paths: string[]): EditorResult<never> => ({
  ok: false,
  code: 'VALIDATION_FAILED',
  fields: [...new Set(paths.map(inputOf))],
});

async function withSession<T>(call: (s: SessionRef) => Promise<ApiResult<T>>): Promise<EditorResult<T>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, code: 'SESSION_REVOKED', fields: [], revoked: true };
  const res = await call(sessionRef(session.user));
  if (res === 'revoked') return { ok: false, code: 'SESSION_REVOKED', fields: [], revoked: true };
  if (res.ok) return { ok: true, data: res.data };
  const field = (res.error?.details as { field?: unknown } | undefined)?.field;
  return {
    ok: false,
    code: res.error?.code ?? (res.status === 0 ? 'NETWORK' : 'INTERNAL'),
    fields: typeof field === 'string' ? [inputOf(field)] : [],
  };
}

const issuePaths = (issues: { path: PropertyKey[] }[]) => issues.map((i) => i.path.map(String).join('.'));

/** Autosave of the listing fields: `body` is the changed fields plus the `version` the editor holds. */
export async function saveListingAction(id: string, body: unknown): Promise<EditorResult<ListingDto>> {
  const parsed = UpdateListingBody.safeParse(body);
  if (!parsed.success) return invalid(issuePaths(parsed.error.issues));
  return withSession((s) => updateListing(s, id, parsed.data));
}

export async function saveTranslationAction(
  id: string,
  locale: string,
  body: unknown,
): Promise<EditorResult<ListingContentDto>> {
  const parsed = PutListingTranslationBody.safeParse(body);
  if (!parsed.success) return invalid(issuePaths(parsed.error.issues));
  return withSession((s) => putListingTranslation(s, id, locale, parsed.data));
}

export async function deleteTranslationAction(
  id: string,
  locale: string,
  version: number,
): Promise<EditorResult<ListingContentDto>> {
  return withSession((s) => deleteListingTranslation(s, id, locale, version));
}

export async function saveFeaturesAction(id: string, body: unknown): Promise<EditorResult<ListingContentDto>> {
  const parsed = SetListingFeaturesBody.safeParse(body);
  if (!parsed.success) return invalid(issuePaths(parsed.error.issues));
  return withSession((s) => setListingFeatures(s, id, parsed.data));
}

export interface CreateState {
  code?: string;
  fields?: string[];
  revoked?: boolean;
}

/** The new-listing form: type, location and transaction → a DRAFT, PRIVATE listing, then its editor. */
export async function createListingAction(_prev: CreateState, form: FormData): Promise<CreateState> {
  const parsed = CreateListingBody.safeParse({
    transactionType: form.get('transactionType') || undefined,
    propertyTypeId: form.get('propertyTypeId'),
    locationId: form.get('locationId'),
  });
  if (!parsed.success) {
    const { fields } = invalid(issuePaths(parsed.error.issues)) as { fields: string[] };
    return { code: 'VALIDATION_FAILED', fields };
  }
  const res = await withSession((s) => createListing(s, parsed.data));
  if (!res.ok) return { code: res.code, fields: res.fields, ...(res.revoked ? { revoked: true } : {}) };
  redirect(getPathname({ href: `/listings/${res.data.id}`, locale: await getLocale() }));
}
