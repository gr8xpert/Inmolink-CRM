/** media DTOs (PATTERNS §9): Zod schemas and inferred types for params, bodies and responses. */
import { z } from 'zod';

/**
 * Listing media upload (S3-03, PLAN §3 #33). The browser hashes each file (SHA-256) and asks which hashes the
 * platform already stores; only unknown ones are uploaded, straight to object storage with a signed PUT bound
 * to the file's exact size and hash; then it registers the files on a listing.
 */

/** Largest original accepted (a 48 MP PNG fits; a 12 MP JPEG is ~5 MB). */
export const MEDIA_MAX_BYTES = 40 * 1024 * 1024;
/** Files per check or register call. */
export const MEDIA_BATCH_MAX = 100;
/** Media rows one listing may have. */
export const MEDIA_PER_LISTING_MAX = 100;
/** Image types accepted as originals, detected by magic bytes (HEIC is converted by the media worker, S3-04). */
export const MEDIA_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;
/** How long a signed upload URL works. */
export const MEDIA_UPLOAD_URL_TTL_SECONDS = 900;

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'a lowercase hex SHA-256');
export const MediaUploadType = z.enum(MEDIA_UPLOAD_TYPES);
/** Kinds a listing's media rows take from uploads (videos and documents arrive with their own tasks). */
export const ListingMediaKind = z.enum(['IMAGE', 'FLOOR_PLAN']);
export type ListingMediaKind = z.infer<typeof ListingMediaKind>;
/** Rooms an image can show (S3-06): set by the agent; AI tagging fills the same field later. */
export const LISTING_ROOM_TYPES = [
  'EXTERIOR',
  'FACADE',
  'LIVING_ROOM',
  'DINING_ROOM',
  'KITCHEN',
  'BEDROOM',
  'BATHROOM',
  'OFFICE',
  'HALL',
  'TERRACE',
  'BALCONY',
  'GARDEN',
  'POOL',
  'GARAGE',
  'STORAGE',
  'VIEW',
  'COMMUNITY',
  'OTHER',
] as const;
export const ListingRoomType = z.enum(LISTING_ROOM_TYPES);
export type ListingRoomType = z.infer<typeof ListingRoomType>;

const uniqueHashes = (files: { sha256: string }[]) => new Set(files.map((f) => f.sha256)).size === files.length;

export const MediaCheckBody = z
  .object({
    files: z
      .array(
        z
          .object({
            sha256: Sha256Hex,
            sizeBytes: z.number().int().min(1).max(MEDIA_MAX_BYTES),
            /** What the browser believes the file is; the stored bytes decide at register. */
            contentType: MediaUploadType,
          })
          .strict(),
      )
      .min(1)
      .max(MEDIA_BATCH_MAX)
      .refine(uniqueHashes, 'each file once'),
  })
  .strict();
export type MediaCheckBody = z.infer<typeof MediaCheckBody>;

export const MediaUpload = z.object({
  url: z.string(),
  method: z.literal('PUT'),
  /** Send exactly these headers with the PUT: they are signed (type, length, checksum). */
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});
export type MediaUpload = z.infer<typeof MediaUpload>;

/** One entry per requested file, in order: STORED needs no upload (zero bytes sent); UPLOAD carries the URL. */
export const MediaCheckResult = z.object({
  files: z.array(
    z.object({
      sha256: Sha256Hex,
      status: z.enum(['STORED', 'UPLOAD']),
      upload: MediaUpload.nullable(),
    }),
  ),
});
export type MediaCheckResult = z.infer<typeof MediaCheckResult>;

export const RegisterMediaBody = z
  .object({
    listingId: z.uuid(),
    /** Insert the files here (0 = first); default: after the listing's last one. */
    position: z.number().int().min(0).max(MEDIA_PER_LISTING_MAX).optional(),
    files: z
      .array(
        z
          .object({
            sha256: Sha256Hex,
            kind: ListingMediaKind.default('IMAGE'),
            /** Make this image the listing's cover. */
            cover: z.boolean().optional(),
            altText: z.string().trim().min(1).max(300).optional(),
            roomType: ListingRoomType.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MEDIA_BATCH_MAX)
      .refine(uniqueHashes, 'each file once')
      .refine((files) => files.filter((f) => f.cover).length <= 1, 'at most one cover')
      .refine((files) => files.every((f) => !f.cover || f.kind === 'IMAGE'), 'only an image can be the cover'),
  })
  .strict();
export type RegisterMediaBody = z.infer<typeof RegisterMediaBody>;

export const VideoProvider = z.enum(['youtube', 'vimeo', 'matterport']);
export type VideoProvider = z.infer<typeof VideoProvider>;

/**
 * A video link (S3-F5): YouTube, Vimeo or a Matterport tour, normalized to the provider and its id. Only these
 * hosts; nothing is fetched. Returns null for anything else.
 */
export function parseVideoUrl(raw: string): { provider: VideoProvider; id: string } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  const path = url.pathname.split('/').filter(Boolean);
  const yt = /^[A-Za-z0-9_-]{11}$/;
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const id =
      path[0] === 'watch'
        ? url.searchParams.get('v')
        : ['embed', 'shorts', 'live'].includes(path[0] ?? '')
          ? path[1]
          : null;
    return id && yt.test(id) ? { provider: 'youtube', id } : null;
  }
  if (host === 'youtu.be') return path[0] && yt.test(path[0]) ? { provider: 'youtube', id: path[0] } : null;
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = host === 'player.vimeo.com' ? (path[0] === 'video' ? path[1] : undefined) : path[0];
    return id && /^\d{1,12}$/.test(id) ? { provider: 'vimeo', id } : null;
  }
  if (host === 'my.matterport.com') {
    const id = path[0] === 'show' ? url.searchParams.get('m') : null;
    return id && /^[A-Za-z0-9]{6,20}$/.test(id) ? { provider: 'matterport', id } : null;
  }
  return null;
}

/** The player URL of a normalized video (built from the id: no user text ends up in it). */
export function videoEmbedUrl(provider: VideoProvider, id: string): string {
  if (provider === 'youtube') return `https://www.youtube-nocookie.com/embed/${id}`;
  if (provider === 'vimeo') return `https://player.vimeo.com/video/${id}`;
  return `https://my.matterport.com/show/?m=${id}`;
}

/** `POST /v1/listings/:id/videos` (S3-F5): a YouTube, Vimeo or Matterport link, last in the order. */
export const AddListingVideoBody = z.object({ url: z.string().trim().min(1).max(500) }).strict();
export type AddListingVideoBody = z.infer<typeof AddListingVideoBody>;

export const ListingVideo = z.object({ provider: VideoProvider, id: z.string(), embedUrl: z.string() });

export const ListingMediaDto = z.object({
  id: z.uuid(),
  /** The file's hash; null for a video link. */
  sha256: Sha256Hex.nullable(),
  kind: z.enum(['IMAGE', 'FLOOR_PLAN', 'VIDEO']),
  /** VIDEO only (S3-F5). */
  video: ListingVideo.nullable(),
  position: z.number().int(),
  isCover: z.boolean(),
  altText: z.string().nullable(),
  roomType: ListingRoomType.nullable(),
  /**
   * The 320 px preview once the media worker has made it (S3-04), as a short-lived signed URL; null while it is
   * processing (the media manager then shows a placeholder).
   */
  thumbUrl: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type ListingMediaDto = z.infer<typeof ListingMediaDto>;

/** A listing's media in order (at most `MEDIA_PER_LISTING_MAX`, so never paginated). */
export const ListingMediaList = z.object({ items: z.array(ListingMediaDto) });
export type ListingMediaList = z.infer<typeof ListingMediaList>;

export const ListingMediaParams = z.object({ id: z.uuid(), mediaId: z.uuid() }).strict();
export type ListingMediaParams = z.infer<typeof ListingMediaParams>;

/** How long a media list's signed preview URLs work (the manager refetches the list after every change). */
export const MEDIA_THUMB_URL_TTL_SECONDS = 3_600;

/** `PATCH /v1/listings/:id/media/:mediaId` (S3-06): what the media manager edits on one file. */
export const UpdateListingMediaBody = z
  .object({
    kind: ListingMediaKind.optional(),
    /** `true` makes this image the cover (the old cover loses it); a cover is never unset, only passed on. */
    cover: z.literal(true).optional(),
    altText: z.string().trim().max(300).nullable().optional(),
    roomType: ListingRoomType.nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'nothing to change')
  .refine((b) => !(b.cover && b.kind === 'FLOOR_PLAN'), 'only an image can be the cover');
export type UpdateListingMediaBody = z.infer<typeof UpdateListingMediaBody>;

/** `PUT /v1/listings/:id/media/order` (S3-06): every media id of the listing, in the new order. */
export const ReorderListingMediaBody = z
  .object({
    ids: z
      .array(z.uuid())
      .min(1)
      .max(MEDIA_PER_LISTING_MAX)
      .refine((ids) => new Set(ids).size === ids.length, 'each id once'),
  })
  .strict();
export type ReorderListingMediaBody = z.infer<typeof ReorderListingMediaBody>;

// ---- Listing documents (S3-F5): private to the owner agency, never on websites ----------------------------------

/** A listing document is a PDF of at most 20 MB (magic bytes checked, never the name or the header). */
export const LISTING_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
/** Documents per listing. */
export const LISTING_DOCUMENTS_MAX = 50;
/** How long an opened document's signed URL works. */
export const LISTING_DOCUMENT_URL_TTL_SECONDS = 300;

export const UploadListingDocumentQuery = z.object({ fileName: z.string().trim().min(1).max(200) }).strict();
export type UploadListingDocumentQuery = z.infer<typeof UploadListingDocumentQuery>;

export const ListingDocumentDto = z.object({
  id: z.uuid(),
  fileName: z.string(),
  sizeBytes: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type ListingDocumentDto = z.infer<typeof ListingDocumentDto>;

export const ListingDocumentList = z.object({ items: z.array(ListingDocumentDto) });
export type ListingDocumentList = z.infer<typeof ListingDocumentList>;

export const ListingDocumentParams = z.object({ id: z.uuid(), documentId: z.uuid() }).strict();
export type ListingDocumentParams = z.infer<typeof ListingDocumentParams>;

/** A short signed GET of the private object (`Content-Disposition` names the file). */
export const ListingDocumentUrlDto = z.object({ url: z.string(), expiresAt: z.iso.datetime() });
export type ListingDocumentUrlDto = z.infer<typeof ListingDocumentUrlDto>;
