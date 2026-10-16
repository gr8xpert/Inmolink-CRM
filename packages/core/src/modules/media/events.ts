import { MEDIA_UPLOAD_TYPES, Sha256Hex } from '@inmolink/contracts';
import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/** Objects per event: 40 × ~130 bytes stays well under the 10 KB payload cap. */
export const OBJECTS_PER_EVENT = 40;

/**
 * media events (PATTERNS §8): emitted with `emit(ctx.tx, …)` in the transaction of the change, so an event
 * exists if and only if the change committed. Hashes only, plus — for an object this request verified in
 * storage and the platform did not know yet — its size and detected type, so the worker can record it.
 */
export const mediaEvents = {
  /** Listing media rows using these objects were added or removed: their reference counts are stale. */
  referencesChanged: defineEvent(
    'media.object.referencesChanged',
    1,
    z.object({
      /** The listing whose media changed (read models, quality score). */
      listingId: z.uuid(),
      objects: z
        .array(
          z.object({
            sha256: Sha256Hex,
            upload: z
              .object({ sizeBytes: z.number().int().positive(), contentType: z.enum(MEDIA_UPLOAD_TYPES) })
              .nullable(),
          }),
        )
        .min(1)
        .max(OBJECTS_PER_EVENT),
    }),
  ),
  /**
   * A listing's media changed without a stored object being added or removed (S3 review): a file's kind, cover,
   * alt text or room type, the order, or a video link added or removed. Read models and the quality score react.
   */
  listingChanged: defineEvent('media.listing.changed', 1, z.object({ listingId: z.uuid() })),
  /**
   * A listing document's row was deleted (S3-F8): the worker deletes its object, retried until it is gone. The
   * key is derived from the event's agency and these ids (`documents/<agency>/<listing>/<id>`), never carried.
   */
  documentDeleted: defineEvent('media.document.deleted', 1, z.object({ listingId: z.uuid(), documentId: z.uuid() })),
};
