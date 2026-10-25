/**
 * Bookmarks (S3-09, PLAN §7 M2): a member's folders of saved listings with notes — any listing they can see,
 * their own agency's or the network's. Private to the member; never in Client Mode (notes are internal). A
 * bookmark outlives the listing leaving the member's view and then lists as unavailable. A folder is one click
 * from a selection (`bookmarkFolderListingIds`, S12-04).
 */
import {
  BOOKMARK_FOLDERS_MAX,
  BOOKMARKS_PER_FOLDER_MAX,
  type BookmarkDto,
  type BookmarkFolderBody,
  type BookmarkFolderDto,
  type BookmarkFolderList,
  type BookmarkPage,
  type CreateBookmarkBody,
  type ListBookmarksQuery,
  type ListingBookmarkList,
  type UpdateBookmarkBody,
} from '@inmolink/contracts';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import type { Ctx } from '../../context';
import { decodeCursor, toPage } from '../../pagination';
import { assertCan } from './policy';
import * as repo from './repo';
import { actorId } from './service';

/** Bookmarks belong to the member and carry internal notes: any use needs a member outside Client Mode. */
function member(ctx: Ctx): repo.MemberRef {
  assertCan(ctx, 'listing.read');
  if (ctx.clientMode) throw new AppError('FORBIDDEN');
  return { agencyId: ctx.tenant.agencyId, userId: actorId(ctx) };
}

/** Unique violations as the caller's error, not a 500. */
const UNIQUE_CODES: Record<string, 'BOOKMARK_FOLDER_NAME_TAKEN' | 'BOOKMARK_EXISTS'> = {
  bookmark_folders_member_name_uq: 'BOOKMARK_FOLDER_NAME_TAKEN',
  listing_bookmarks_folder_property_uq: 'BOOKMARK_EXISTS',
};

async function withUniqueCheck<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
    const code = cause?.code === '23505' && cause.constraint ? UNIQUE_CODES[cause.constraint] : undefined;
    if (code) throw new AppError(code);
    throw err;
  }
}

function folderDto(row: repo.FolderRow): BookmarkFolderDto {
  return { id: row.id, name: row.name, count: row.count, updatedAt: row.updatedAt.toISOString() };
}

function bookmarkDto(ctx: Ctx, row: repo.FolderBookmarkRow): BookmarkDto {
  const l = row.listing;
  // RLS hid the listing (null) or the owner deleted it: unavailable, whatever it was when saved.
  const available = l !== null && l.deletedAt === null;
  return {
    id: row.id,
    folderId: row.folderId,
    listingId: row.propertyId,
    note: row.note,
    available,
    listing:
      available && l
        ? {
            ref: l.ref,
            status: l.status,
            transactionType: l.transactionType,
            price: l.priceCents === null ? null : { amountCents: l.priceCents, currency: l.currency },
            bedrooms: l.bedrooms,
            builtM2: l.builtM2 === null ? null : Number(l.builtM2),
            propertyTypeId: l.propertyTypeId,
            locationId: l.locationId,
            own: l.agencyId === ctx.tenant.agencyId,
          }
        : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A listing the caller can see now (RLS) and that is not deleted — their own deleted ones included. */
async function assertBookmarkable(ctx: Ctx, listingId: string): Promise<void> {
  const row = await repo.getListing(ctx.tx, listingId);
  if (!row || row.deletedAt) throw new AppError('LISTING_NOT_FOUND');
}

/** Locks the member's folder and checks it has room (`BOOKMARKS_PER_FOLDER_MAX`). */
async function assertFolderHasRoom(ctx: Ctx, ref: repo.MemberRef, folderId: string): Promise<void> {
  const folder = await repo.lockFolder(ctx.tx, { ...ref, id: folderId });
  if (!folder) throw new AppError('BOOKMARK_FOLDER_NOT_FOUND');
  if (folder.count >= BOOKMARKS_PER_FOLDER_MAX) {
    throw new AppError('BOOKMARK_FOLDER_FULL', { max: BOOKMARKS_PER_FOLDER_MAX });
  }
}

// ---- Folders -------------------------------------------------------------------------------------------------

/** `GET /v1/bookmark-folders`: the caller's folders by name, with sizes. */
export async function listBookmarkFolders(ctx: Ctx): Promise<BookmarkFolderList> {
  const rows = await repo.listFolders(ctx.tx, member(ctx), BOOKMARK_FOLDERS_MAX);
  return { items: rows.map(folderDto) };
}

/** `POST /v1/bookmark-folders`. */
export async function createBookmarkFolder(ctx: Ctx, body: BookmarkFolderBody): Promise<BookmarkFolderDto> {
  const ref = member(ctx);
  const row = await withUniqueCheck(() =>
    repo.insertFolder(ctx.tx, { ...ref, id: newId(), name: body.name }, BOOKMARK_FOLDERS_MAX),
  );
  if (!row) throw new AppError('BOOKMARK_FOLDER_LIMIT', { max: BOOKMARK_FOLDERS_MAX });
  return folderDto(row);
}

/** `PUT /v1/bookmark-folders/:id`: renames one of the caller's folders. */
export async function renameBookmarkFolder(ctx: Ctx, id: string, body: BookmarkFolderBody): Promise<BookmarkFolderDto> {
  const ref = { ...member(ctx), id };
  const renamed = await withUniqueCheck(() => repo.renameFolder(ctx.tx, ref, body.name));
  const row = renamed ? await repo.getFolder(ctx.tx, ref) : null;
  if (!row) throw new AppError('BOOKMARK_FOLDER_NOT_FOUND');
  return folderDto(row);
}

/** `DELETE /v1/bookmark-folders/:id`: the folder and its bookmarks. */
export async function deleteBookmarkFolder(ctx: Ctx, id: string): Promise<void> {
  const deleted = await repo.deleteFolder(ctx.tx, { ...member(ctx), id });
  if (!deleted) throw new AppError('BOOKMARK_FOLDER_NOT_FOUND');
}

/**
 * The listings of one of the caller's folders they can still see, oldest bookmark first (≤ 500) — what
 * "create selection from folder" starts from (S12-04). Unavailable bookmarks are left out, never an error.
 */
export async function bookmarkFolderListingIds(ctx: Ctx, folderId: string): Promise<string[]> {
  const ref = member(ctx);
  const folder = await repo.getFolder(ctx.tx, { ...ref, id: folderId });
  if (!folder) throw new AppError('BOOKMARK_FOLDER_NOT_FOUND');
  return repo.visibleFolderListingIds(ctx.tx, { ...ref, folderId }, BOOKMARKS_PER_FOLDER_MAX);
}

// ---- Bookmarks -----------------------------------------------------------------------------------------------

/** `GET /v1/bookmark-folders/:id/bookmarks`: newest first, keyset ≤ 100; unavailable listings flagged. */
export async function listBookmarks(ctx: Ctx, folderId: string, query: ListBookmarksQuery): Promise<BookmarkPage> {
  const ref = member(ctx);
  const cursor = decodeCursor(query.cursor);
  const folder = await repo.getFolder(ctx.tx, { ...ref, id: folderId });
  if (!folder) throw new AppError('BOOKMARK_FOLDER_NOT_FOUND');
  const rows = await repo.listFolderBookmarks(ctx.tx, { ...ref, folderId }, cursor, query.limit);
  return toPage(
    rows,
    query.limit,
    (r) => ({ at: r.createdAt, id: r.id, atUs: r.atUs }),
    (r) => bookmarkDto(ctx, r),
  );
}

/** `GET /v1/listings/:id/bookmarks`: which of the caller's folders hold this listing. */
export async function listListingBookmarks(ctx: Ctx, listingId: string): Promise<ListingBookmarkList> {
  const rows = await repo.listListingBookmarks(ctx.tx, member(ctx), listingId, BOOKMARK_FOLDERS_MAX);
  return { items: rows };
}

/** `POST /v1/bookmarks`: saves a listing the caller can see into one of their folders. */
export async function createBookmark(ctx: Ctx, body: CreateBookmarkBody): Promise<BookmarkDto> {
  const ref = member(ctx);
  await assertBookmarkable(ctx, body.listingId);
  await assertFolderHasRoom(ctx, ref, body.folderId);
  const saved = await withUniqueCheck(() =>
    repo.insertBookmark(ctx.tx, {
      ...ref,
      id: newId(),
      folderId: body.folderId,
      propertyId: body.listingId,
      note: body.note || null,
    }),
  );
  return readBookmark(ctx, ref, saved.id);
}

/** `PATCH /v1/bookmarks/:id`: a new note, or a move to another of the caller's folders. */
export async function updateBookmark(ctx: Ctx, id: string, body: UpdateBookmarkBody): Promise<BookmarkDto> {
  const ref = member(ctx);
  const current = await repo.getBookmark(ctx.tx, { ...ref, id });
  if (!current) throw new AppError('BOOKMARK_NOT_FOUND');
  const move = body.folderId !== undefined && body.folderId !== current.folderId;
  if (move) await assertFolderHasRoom(ctx, ref, body.folderId as string);
  const saved = await withUniqueCheck(() =>
    repo.updateBookmark(
      ctx.tx,
      { ...ref, id },
      {
        ...(move ? { folderId: body.folderId } : {}),
        ...(body.note !== undefined ? { note: body.note || null } : {}),
      },
    ),
  );
  if (!saved) throw new AppError('BOOKMARK_NOT_FOUND');
  return readBookmark(ctx, ref, saved.id);
}

/** `DELETE /v1/bookmarks/:id`. */
export async function deleteBookmark(ctx: Ctx, id: string): Promise<void> {
  const deleted = await repo.deleteBookmark(ctx.tx, { ...member(ctx), id });
  if (!deleted) throw new AppError('BOOKMARK_NOT_FOUND');
}

/** The saved bookmark with its listing as the caller sees it. */
async function readBookmark(ctx: Ctx, ref: repo.MemberRef, id: string): Promise<BookmarkDto> {
  const row = await repo.getBookmarkWithListing(ctx.tx, { ...ref, id });
  if (!row) throw new AppError('BOOKMARK_NOT_FOUND');
  return bookmarkDto(ctx, row);
}
