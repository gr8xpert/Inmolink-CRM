'use server';

import {
  AddListingVideoBody,
  type BookmarkDto,
  BookmarkFolderBody,
  type BookmarkFolderDto,
  type BookmarkFolderList,
  CreateBookmarkBody,
  CreateListingBody,
  type ListingBookmarkList,
  type ListingBulkDto,
  type ListingContentDto,
  type ListingDocumentList,
  type ListingDocumentUrlDto,
  type ListingDto,
  type ListingMediaList,
  type ListingOverrideDto,
  type ListingOverrideList,
  ListingOverrideTarget,
  type ListingQualityDto,
  ListingViewBody,
  type ListingViewDto,
  MediaCheckBody,
  type MediaCheckResult,
  PutListingOverrideBody,
  PutListingTranslationBody,
  RegisterMediaBody,
  ReorderListingMediaBody,
  SetListingFeaturesBody,
  StartListingBulkBody,
  UpdateBookmarkBody,
  UpdateListingBody,
  UpdateListingMediaBody,
} from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import {
  type ApiResult,
  addListingVideo,
  checkMedia,
  confirmListing,
  createBookmark,
  createBookmarkFolder,
  createListing,
  createListingView,
  deleteBookmark,
  deleteBookmarkFolder,
  deleteListingDocument,
  deleteListingOverride,
  deleteListingTranslation,
  deleteListingView,
  detachListingMedia,
  fetchBookmarkFolders,
  fetchListingBookmarks,
  fetchListingBulkAction,
  fetchListingOverrides,
  fetchListingQuality,
  listListingDocuments,
  listListingMedia,
  openListingDocument,
  putListingOverride,
  putListingTranslation,
  registerMedia,
  renameBookmarkFolder,
  reorderListingMedia,
  type SessionRef,
  sessionRef,
  setListingFeatures,
  startListingBulkAction,
  updateBookmark,
  updateListing,
  updateListingMedia,
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

// --- media manager (S3-06): the browser hashes and uploads straight to storage; these carry the API calls ---

const Uuid = z.uuid();
const badId = (): EditorResult<never> => invalid(['id']);

/** The listing's live quality score and hints (S3-08), for the panel's refresh after a saved change. */
export async function listingQualityAction(id: string): Promise<EditorResult<ListingQualityDto>> {
  if (!Uuid.safeParse(id).success) return badId();
  return withSession((s) => fetchListingQuality(s, id));
}

/** "Still on the market" (S3-08); answers the confirmed listing. */
export async function confirmListingAction(id: string): Promise<EditorResult<ListingDto>> {
  if (!Uuid.safeParse(id).success) return badId();
  return withSession((s) => confirmListing(s, id));
}

/** Which of these files the platform stores already, and signed upload URLs for the others (≤ 100). */
export async function checkMediaAction(body: unknown): Promise<EditorResult<MediaCheckResult>> {
  const parsed = MediaCheckBody.safeParse(body);
  if (!parsed.success) return invalid(issuePaths(parsed.error.issues));
  return withSession((s) => checkMedia(s, parsed.data));
}

/** Attaches uploaded or stored files to the listing, in order; answers the listing's media. */
export async function registerMediaAction(body: unknown): Promise<EditorResult<ListingMediaList>> {
  const parsed = RegisterMediaBody.safeParse(body);
  if (!parsed.success) return invalid(issuePaths(parsed.error.issues));
  return withSession((s) => registerMedia(s, parsed.data));
}

export async function listMediaAction(id: string): Promise<EditorResult<ListingMediaList>> {
  if (!Uuid.safeParse(id).success) return badId();
  return withSession((s) => listListingMedia(s, id));
}

export async function updateMediaAction(
  id: string,
  mediaId: string,
  body: unknown,
): Promise<EditorResult<ListingMediaList>> {
  if (!Uuid.safeParse(id).success || !Uuid.safeParse(mediaId).success) return badId();
  const parsed = UpdateListingMediaBody.safeParse(body);
  if (!parsed.success) return invalid(issuePaths(parsed.error.issues));
  return withSession((s) => updateListingMedia(s, id, mediaId, parsed.data));
}

export async function reorderMediaAction(id: string, body: unknown): Promise<EditorResult<ListingMediaList>> {
  if (!Uuid.safeParse(id).success) return badId();
  const parsed = ReorderListingMediaBody.safeParse(body);
  if (!parsed.success) return invalid(issuePaths(parsed.error.issues));
  return withSession((s) => reorderListingMedia(s, id, parsed.data));
}

/** A video link (YouTube, Vimeo, Matterport), last in the order; answers the listing's media (S3-F5). */
export async function addVideoAction(id: string, body: unknown): Promise<EditorResult<ListingMediaList>> {
  if (!Uuid.safeParse(id).success) return badId();
  const parsed = AddListingVideoBody.safeParse(body);
  if (!parsed.success) return invalid(issuePaths(parsed.error.issues));
  return withSession((s) => addListingVideo(s, id, parsed.data.url));
}

/** The listing's private documents (S3-F5). */
export async function listDocumentsAction(id: string): Promise<EditorResult<ListingDocumentList>> {
  if (!Uuid.safeParse(id).success) return badId();
  return withSession((s) => listListingDocuments(s, id));
}

/** A short signed download URL of one document. */
export async function openDocumentAction(id: string, documentId: string): Promise<EditorResult<ListingDocumentUrlDto>> {
  if (!Uuid.safeParse(id).success || !Uuid.safeParse(documentId).success) return badId();
  return withSession((s) => openListingDocument(s, id, documentId));
}

/** Removes a document; answers the documents left. */
export async function deleteDocumentAction(id: string, documentId: string): Promise<EditorResult<ListingDocumentList>> {
  if (!Uuid.safeParse(id).success || !Uuid.safeParse(documentId).success) return badId();
  const removed = await withSession((s) => deleteListingDocument(s, id, documentId));
  if (!removed.ok) return removed;
  return withSession((s) => listListingDocuments(s, id));
}

/** Removes a file from the listing; answers the listing's media as it is now. */
export async function detachMediaAction(id: string, mediaId: string): Promise<EditorResult<ListingMediaList>> {
  if (!Uuid.safeParse(id).success || !Uuid.safeParse(mediaId).success) return badId();
  const removed = await withSession((s) => detachListingMedia(s, id, mediaId));
  if (!removed.ok) return removed;
  return withSession((s) => listListingMedia(s, id));
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

// --- listing list (S3-07): saved views and bulk actions ---

/** Saves the list as it is now (filters, sort, columns) under a name. */
export async function saveViewAction(body: unknown): Promise<EditorResult<ListingViewDto>> {
  const parsed = ListingViewBody.safeParse(body);
  if (!parsed.success) return invalid(issuePaths(parsed.error.issues));
  return withSession((s) => createListingView(s, parsed.data));
}

export async function deleteViewAction(id: string): Promise<EditorResult<null>> {
  if (!Uuid.safeParse(id).success) return badId();
  return withSession((s) => deleteListingView(s, id));
}

/** Queues a bulk action; the list then polls `bulkProgressAction` until it is DONE or FAILED. */
export async function startBulkAction(body: unknown): Promise<EditorResult<ListingBulkDto>> {
  const parsed = StartListingBulkBody.safeParse(body);
  if (!parsed.success) return invalid(issuePaths(parsed.error.issues));
  return withSession((s) => startListingBulkAction(s, parsed.data));
}

export async function bulkProgressAction(id: string): Promise<EditorResult<ListingBulkDto>> {
  if (!Uuid.safeParse(id).success) return badId();
  return withSession((s) => fetchListingBulkAction(s, id));
}

// --- bookmarks (S3-09): folders of saved listings with notes ---

/** The caller's folders and which of them hold `listingId` (the editor's bookmark button). */
export async function listingBookmarksAction(
  listingId: string,
): Promise<EditorResult<{ folders: BookmarkFolderList; bookmarks: ListingBookmarkList }>> {
  if (!Uuid.safeParse(listingId).success) return badId();
  const folders = await withSession((s) => fetchBookmarkFolders(s));
  if (!folders.ok) return folders;
  const bookmarks = await withSession((s) => fetchListingBookmarks(s, listingId));
  if (!bookmarks.ok) return bookmarks;
  return { ok: true, data: { folders: folders.data, bookmarks: bookmarks.data } };
}

export async function createFolderAction(body: unknown): Promise<EditorResult<BookmarkFolderDto>> {
  const parsed = BookmarkFolderBody.safeParse(body);
  if (!parsed.success) return invalid(issuePaths(parsed.error.issues));
  return withSession((s) => createBookmarkFolder(s, parsed.data));
}

export async function renameFolderAction(id: string, body: unknown): Promise<EditorResult<BookmarkFolderDto>> {
  if (!Uuid.safeParse(id).success) return badId();
  const parsed = BookmarkFolderBody.safeParse(body);
  if (!parsed.success) return invalid(issuePaths(parsed.error.issues));
  return withSession((s) => renameBookmarkFolder(s, id, parsed.data));
}

export async function deleteFolderAction(id: string): Promise<EditorResult<null>> {
  if (!Uuid.safeParse(id).success) return badId();
  return withSession((s) => deleteBookmarkFolder(s, id));
}

export async function createBookmarkAction(body: unknown): Promise<EditorResult<BookmarkDto>> {
  const parsed = CreateBookmarkBody.safeParse(body);
  if (!parsed.success) return invalid(issuePaths(parsed.error.issues));
  return withSession((s) => createBookmark(s, parsed.data));
}

export async function updateBookmarkAction(id: string, body: unknown): Promise<EditorResult<BookmarkDto>> {
  if (!Uuid.safeParse(id).success) return badId();
  const parsed = UpdateBookmarkBody.safeParse(body);
  if (!parsed.success) return invalid(issuePaths(parsed.error.issues));
  return withSession((s) => updateBookmark(s, id, parsed.data));
}

export async function deleteBookmarkAction(id: string): Promise<EditorResult<null>> {
  if (!Uuid.safeParse(id).success) return badId();
  return withSession((s) => deleteBookmark(s, id));
}

// --- listing overrides (S3-10): the agency's own title/description of another agency's listing or new build ---

const ContentLocale = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/);

export async function listingOverridesAction(kind: unknown, id: string): Promise<EditorResult<ListingOverrideList>> {
  const target = ListingOverrideTarget.safeParse(kind);
  if (!target.success || !Uuid.safeParse(id).success) return badId();
  return withSession((s) => fetchListingOverrides(s, target.data, id));
}

export async function saveListingOverrideAction(
  kind: unknown,
  id: string,
  locale: string,
  body: unknown,
): Promise<EditorResult<ListingOverrideDto>> {
  const target = ListingOverrideTarget.safeParse(kind);
  if (!target.success || !Uuid.safeParse(id).success || !ContentLocale.safeParse(locale).success) return badId();
  const parsed = PutListingOverrideBody.safeParse(body);
  if (!parsed.success) return invalid(issuePaths(parsed.error.issues));
  return withSession((s) => putListingOverride(s, target.data, id, locale, parsed.data));
}

export async function deleteListingOverrideAction(
  kind: unknown,
  id: string,
  locale: string,
): Promise<EditorResult<null>> {
  const target = ListingOverrideTarget.safeParse(kind);
  if (!target.success || !Uuid.safeParse(id).success || !ContentLocale.safeParse(locale).success) return badId();
  return withSession((s) => deleteListingOverride(s, target.data, id, locale));
}
