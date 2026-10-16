/**
 * Per-user concurrency cap for upload routes that buffer the body (S3-F8): one user cannot hold more than
 * `limit` bodies in this process's memory at once (20 MB each for listing documents). Taken before the body is
 * read and released when the request ends; a request over the cap is answered 429 without reading it. Per
 * process on purpose — the memory it protects is the process's; the API's rate limits cover the rest.
 */
export interface UploadSlots {
  /** A release function, or null when the user already holds `limit` slots. */
  take(userId: string): (() => void) | null;
  /** Slots the user holds now (tests, metrics). */
  held(userId: string): number;
}

export function createUploadSlots(limit: number): UploadSlots {
  const inFlight = new Map<string, number>();
  return {
    take(userId) {
      const n = inFlight.get(userId) ?? 0;
      if (n >= limit) return null;
      inFlight.set(userId, n + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (inFlight.get(userId) ?? 1) - 1;
        if (left <= 0) inFlight.delete(userId);
        else inFlight.set(userId, left);
      };
    },
    held: (userId) => inFlight.get(userId) ?? 0,
  };
}

/** Listing document uploads: two at a time per user (the media manager sends them one after another). */
export const LISTING_DOCUMENT_UPLOAD_SLOTS = 2;
export const listingDocumentUploads = createUploadSlots(LISTING_DOCUMENT_UPLOAD_SLOTS);
