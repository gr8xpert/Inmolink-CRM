import {
  createUploadSlots,
  LISTING_DOCUMENT_UPLOAD_SLOTS,
  LISTING_DOCUMENT_UPLOAD_TOTAL,
} from '@inmolink/platform/rate-limit';

/** The web relay's own cap (its process buffers the body too); the API enforces the same caps (S3 review). */
export const listingDocumentUploads = createUploadSlots(LISTING_DOCUMENT_UPLOAD_SLOTS, LISTING_DOCUMENT_UPLOAD_TOTAL);
