/**
 * Concurrency cap for upload routes that buffer the body (S3-F8, S3 review): one user cannot hold more than
 * `perUser` bodies in this process's memory at once, and the process holds at most `total` (20 MB each for
 * listing documents). Taken before the body is read and released when the request ends; a request over a cap is
 * answered 429 without reading it. Per process on purpose — the memory it protects is the process's; the rate
 * limits cover the rest. Used by the API route and by the web relay in front of it.
 */
export interface UploadSlots {
  /** A release function (idempotent), or null when the user or the process is at its cap. */
  take(userId: string): (() => void) | null;
  /** Slots the user holds now (tests, metrics). */
  held(userId: string): number;
  /** Slots held in this process now (tests, metrics). */
  total(): number;
}

export function createUploadSlots(perUser: number, total = Number.POSITIVE_INFINITY): UploadSlots {
  const inFlight = new Map<string, number>();
  let all = 0;
  return {
    take(userId) {
      const n = inFlight.get(userId) ?? 0;
      if (n >= perUser || all >= total) return null;
      inFlight.set(userId, n + 1);
      all += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        all -= 1;
        const left = (inFlight.get(userId) ?? 1) - 1;
        if (left <= 0) inFlight.delete(userId);
        else inFlight.set(userId, left);
      };
    },
    held: (userId) => inFlight.get(userId) ?? 0,
    total: () => all,
  };
}

/** Listing document uploads: two at a time per user (the media manager sends them one after another). */
export const LISTING_DOCUMENT_UPLOAD_SLOTS = 2;
/** Listing document bodies buffered at once per process: 8 × 20 MB = 160 MB at most. */
export const LISTING_DOCUMENT_UPLOAD_TOTAL = 8;
