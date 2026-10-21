/** media — public API (PATTERNS §1). The only import path for other modules and apps. */

export { DOCUMENT_ORPHAN_MIN_AGE_MS, mediaDocumentJobs, requestDocumentPurge } from './document-jobs';
export {
  configureDocumentScanner,
  type DocumentScanner,
  deleteListingDocument,
  listListingDocuments,
  openListingDocument,
  uploadListingDocument,
} from './documents';
export { mediaErrors } from './errors';
export { mediaEvents } from './events';
export {
  configureFeedImages,
  FEED_IMAGES,
  FEED_STAGING_PREFIX,
  type FeedImagesResult,
  importFeedImages,
  queueFeedImages,
} from './feed-images';
export { MEDIA_DELETE_GRACE_DAYS, mediaJobs, requestFeedImages, requestVariants } from './jobs';
export { CLIENT_MODE_ALLOWED, can, MEDIA_ACTIONS, MEDIA_IMPERSONATION } from './policy';
export { hammingDistance } from './processing';
export { mediaForReadModels, type ReadModelMediaSet } from './read-models';
export {
  addListingVideo,
  checkUploads,
  detachListingMedia,
  listingImageSizes,
  listingsImageSizes,
  listListingMedia,
  originalKey,
  registerUploads,
  reorderListingMedia,
  updateListingMedia,
} from './service';
export { registerMediaSubscriptions, unregisterMediaSubscriptions } from './subscriptions';
export {
  ALL_VARIANTS_MASK,
  configureMedia,
  MEDIA_PIPELINE_VERSION,
  /** Private: for ops tooling and tests that clean up stored files. */
  masterKey,
  VARIANT_NAMES,
  VARIANTS,
  type VariantName,
  variantKey,
  variantsIn,
} from './variants';
// Never export repo or schema.
