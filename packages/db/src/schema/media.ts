/**
 * Tables owned by the media module (PATTERNS §2). Only `packages/core/src/modules/media` imports
 * this file (`pnpm check:boundaries`). Register each table in `../tenancy/registry.ts`, then run
 * `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 *
 * Media are content-addressed (PLAN §3 #33, S3-03): one stored original per SHA-256 for the whole platform,
 * however many listings and agencies use it. `media_objects` is that global registry (written only by the
 * media worker, `withSystem()`); `property_media` is a listing's ordered use of an object, by hash — so read
 * models build variant keys (`v{pipeline}/{sha}/{size}.webp`, S3-04) without a join.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agencies } from './agencies';
import { properties } from './properties';

const SHA256_HEX = (column: unknown) => sql`${column} ~ '^[0-9a-f]{64}$'`;

/**
 * One stored original per content hash (global: no `agency_id`). `refcount` counts `property_media` rows
 * using the hash across every agency; the media worker recounts it after each change (idempotent), and at 0
 * sets `delete_after` — the orphan cleanup (S3-04) deletes the object once that passes, unless it is used again.
 */
export const mediaObjects = pgTable(
  'media_objects',
  {
    sha256: char('sha256', { length: 64 }).primaryKey(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    /** Detected from the stored bytes (magic bytes), never the client's header. */
    contentType: text('content_type').notNull(),
    /** 64-bit perceptual hash for near-duplicate detection; filled by the processing worker (S3-04). */
    phash: bigint('phash', { mode: 'bigint' }),
    /**
     * Processing (S3-04): the variant pipeline version the stored variants were made with (null = not
     * processed yet), which of that version's variants exist (bit per size, `media/variants.ts`), and the
     * normalized master's pixel size.
     */
    pipeline: smallint('pipeline'),
    variantsReady: smallint('variants_ready').notNull().default(0),
    width: integer('width'),
    height: integer('height'),
    /**
     * Processing failed for good (unreadable image, original missing or not matching its hash) while listings
     * use the object: its original is deleted and the next check asks for a fresh upload.
     */
    failedAt: timestamp('failed_at', { withTimezone: true }),
    refcount: integer('refcount').notNull().default(0),
    deleteAfter: timestamp('delete_after', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // orphan cleanup (S3-04): unreferenced objects, the ones due first
    index('media_objects_delete_after_idx').on(t.deleteAfter).where(sql`${t.deleteAfter} is not null`),
    // reconciler (S3-04): recorded objects whose processing never finished
    index('media_objects_unprocessed_idx').on(t.createdAt).where(sql`${t.pipeline} is null and ${t.failedAt} is null`),
    check('media_objects_sha256_ck', SHA256_HEX(t.sha256)),
    check('media_objects_size_ck', sql`${t.sizeBytes} > 0`),
    check('media_objects_refcount_ck', sql`${t.refcount} >= 0`),
    check(
      'media_objects_processed_ck',
      sql`(${t.pipeline} is null and ${t.variantsReady} = 0) or (${t.pipeline} > 0 and ${t.variantsReady} >= 0 and ${t.width} > 0 and ${t.height} > 0)`,
    ),
    check(
      'media_objects_content_type_ck',
      sql`${t.contentType} in ('image/jpeg', 'image/png', 'image/webp', 'image/heic')`,
    ),
  ],
);

export const propertyMediaKindEnum = pgEnum('property_media_kind', ['IMAGE', 'FLOOR_PLAN', 'VIDEO', 'DOCUMENT']);

/**
 * The listing's media in order: its use of a content-addressed object, by hash (no variant rows) — or a video link
 * (S3-F5: kind VIDEO, no hash, the provider and its normalized id; nothing is fetched). Documents are not media:
 * they live in `listing_documents`, private to the agency (kind DOCUMENT is refused here).
 */
export const propertyMedia = pgTable(
  'property_media',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id').notNull(),
    agencyId: uuid('agency_id').notNull(),
    /** The object's hash; null for a video link. */
    sha256: char('sha256', { length: 64 }),
    kind: propertyMediaKindEnum('kind').notNull().default('IMAGE'),
    /** VIDEO only (S3-F5): `youtube`, `vimeo` or `matterport`, and the id the embed URL is built from. */
    videoProvider: text('video_provider'),
    videoId: text('video_id'),
    position: integer('position').notNull(),
    isCover: boolean('is_cover').notNull().default(false),
    altText: text('alt_text'),
    /** Room shown (`kitchen`, `bedroom`, …): AI-tagged or set by the agent. */
    roomType: text('room_type'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'property_media_property_fk',
      columns: [t.propertyId, t.agencyId],
      foreignColumns: [properties.id, properties.agencyId],
    }).onDelete('cascade'),
    // FK + a listing's media in order
    index('property_media_property_idx').on(t.propertyId, t.position),
    // one cover per listing
    uniqueIndex('property_media_cover_uq').on(t.propertyId).where(sql`${t.isCover}`),
    // a file is attached to a listing once (a retried register is a no-op)
    unique('property_media_property_sha_uq').on(t.propertyId, t.sha256),
    // reference counting of a media object (media.syncObjects)
    index('property_media_sha_idx').on(t.sha256),
    check('property_media_position_ck', sql`${t.position} >= 0`),
    check('property_media_sha256_ck', SHA256_HEX(t.sha256)),
    // a video is a link (provider + id, no file); everything else is a stored file, never a document (S3-F5)
    check(
      'property_media_video_ck',
      sql`(${t.kind} = 'VIDEO') = (${t.sha256} is null) and (${t.kind} = 'VIDEO') = (${t.videoProvider} is not null and ${t.videoId} is not null)`,
    ),
    check('property_media_no_document_ck', sql`${t.kind} <> 'DOCUMENT'`),
    check('property_media_video_provider_ck', sql`${t.videoProvider} in ('youtube', 'vimeo', 'matterport')`),
    // a video is linked to a listing once
    uniqueIndex('property_media_video_uq').on(t.propertyId, t.videoProvider, t.videoId).where(sql`${t.kind} = 'VIDEO'`),
  ],
);

/**
 * A listing's documents (S3-F5: nota simple, contracts, plans as PDF). Private to the owner agency: STRICT, per-agency
 * keys in the private bucket (`documents/<agency>/<listing>/<id>`), never content-addressed or shared, never on
 * websites; opened through a short signed URL.
 */
export const listingDocuments = pgTable(
  'listing_documents',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id').notNull(),
    propertyId: uuid('property_id').notNull(),
    /** Display name as uploaded (sanitized). */
    fileName: text('file_name').notNull(),
    /** Detected from the file's magic bytes: `application/pdf`. */
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    storageKey: text('storage_key').notNull(),
    uploadedBy: uuid('uploaded_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'listing_documents_property_fk',
      columns: [t.propertyId, t.agencyId],
      foreignColumns: [properties.id, properties.agencyId],
    }).onDelete('cascade'),
    // FK + a listing's documents: where agency_id = ? and property_id = ? order by created_at, id
    index('listing_documents_property_idx').on(t.agencyId, t.propertyId, t.createdAt, t.id),
    uniqueIndex('listing_documents_key_uq').on(t.storageKey),
    // the same file once per listing (a retried upload answers with the document it made)
    unique('listing_documents_property_sha_uq').on(t.propertyId, t.sha256),
    check('listing_documents_sha256_ck', SHA256_HEX(t.sha256)),
    check('listing_documents_type_ck', sql`${t.contentType} = 'application/pdf'`),
    check('listing_documents_size_ck', sql`${t.sizeBytes} > 0`),
  ],
);

/**
 * A listing's feed images waiting to be fetched (S6-02): the import writes the listing's image URLs, in feed order,
 * in the batch transaction (one row per listing; a newer list replaces a waiting one); the `media.importFeedImages`
 * worker downloads them outside any transaction, hashes them first (a URL fetched before, or a hash stored already,
 * is not downloaded or uploaded again) and attaches the new ones. `claimed_until` leases a row to one worker.
 */
export const feedImageQueue = pgTable(
  'feed_image_queue',
  {
    propertyId: uuid('property_id').primaryKey(),
    agencyId: uuid('agency_id').notNull(),
    urls: text('urls').array().notNull(),
    claimedUntil: timestamp('claimed_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'feed_image_queue_property_fk',
      columns: [t.propertyId, t.agencyId],
      foreignColumns: [properties.id, properties.agencyId],
    }).onDelete('cascade'),
    // FK + the agency's waiting listings, oldest first (the worker's claim); the sweep (`media.sweepFeedImages`)
    // skip-scans it for the agencies with waiting rows (S7-F3: no `updated_at` index, so claims stay HOT updates)
    index('feed_image_queue_agency_created_idx').on(t.agencyId, t.createdAt),
    check('feed_image_queue_urls_ck', sql`cardinality(${t.urls}) between 1 and 100`),
  ],
);

/**
 * Feed image URL → the content hash it served (S6-02, per agency): hash-first, so a URL already fetched is never
 * downloaded again while its object is stored. `url_key` is the SHA-256 of the URL (URLs can be long).
 */
export const feedImageSources = pgTable(
  'feed_image_sources',
  {
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    urlKey: char('url_key', { length: 64 }).notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.agencyId, t.urlKey] }),
    check('feed_image_sources_url_key_ck', SHA256_HEX(t.urlKey)),
    check('feed_image_sources_sha256_ck', SHA256_HEX(t.sha256)),
  ],
);
