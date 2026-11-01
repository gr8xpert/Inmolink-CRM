import { AGENCY_LOGO_MAX_BYTES, MEMBER_PHOTO_MAX_BYTES } from '@inmolink/contracts';
import { type Tx, withSystem } from '@inmolink/db';
import type { Logger } from '@inmolink/platform/logger';
import { emit } from '@inmolink/platform/outbox';
import { storage } from '@inmolink/platform/storage';
import * as agencies from '../agencies';
import * as identity from '../identity';
import { mediaEvents } from './events';
import { ImageInputError, portalImage, withImageSlot } from './processing';

/**
 * Portal images (S15-F10): the public copies of an agency's logo and of its members' profile photos. Both are uploaded
 * to the private bucket (served to the dashboard by signed links only); the portal shows a re-encoded copy (metadata
 * stripped, WebP) in the media bucket, which the CDN serves — and only while it may be public:
 *
 * - the logo while the agency is listed in the directory (VERIFIED);
 * - a member's photo while their profile is published, they are an active member, and the agency is listed.
 *
 * `publishPortalImages(agencyId)` reconciles one agency: every image that should be public and is not gets its copy
 * (`portal/<kind>/<agency>/<upload id>.webp` — a new upload is a new key), recorded on its row only while the row still
 * holds that upload; every copy that should not be public (any more) is cleared on its row and deleted. Each change
 * recorded emits `media.portalImages.changed` in its transaction: website-api marks the agency's portal pages
 * (`portal:a:<agency>`) so cached cards and profiles pick up the new logo / photo or drop the removed one.
 * Idempotent: a repeated run finds nothing to do. Triggered by the logo, profile, member and status events
 * (subscriptions); runs in the `imports` pool, which reads the private bucket and writes the media bucket (the `media`
 * pool's credentials reach neither private objects nor these rows).
 */

/**
 * S15-F10 review: a copy is withdrawn (unpublished, member deactivated, agency off the directory) by deleting its
 * object, so its lifetime in browsers and at the CDN bounds how long a withdrawn photo or logo can still be seen:
 * 5 minutes, never `immutable`. Unlike listing variants (`v<n>/…`, a year, immutable: a listing photo is not personal
 * data and stays as long as the listing), a member photo is. The key changes with every upload, so a short lifetime
 * costs only revalidations, not stale images.
 */
export const PORTAL_IMAGE_CACHE = 'public, max-age=300';
/** Logos: the whole image within this box (transparency kept). */
export const PORTAL_LOGO_PX = 400;
/** Photos: a centre-cropped square. */
export const PORTAL_PHOTO_PX = 480;
/** Profiles read per statement; the run pages through all of them by user id (keyset). */
export const PORTAL_PHOTO_PAGE = 200;

/** The public key of an upload: the upload's own id (its key's last part) under the portal prefix. */
export function portalImageKey(kind: 'agency-logos' | 'member-photos', agencyId: string, storageKey: string): string {
  const id = storageKey.slice(storageKey.lastIndexOf('/') + 1);
  return `portal/${kind}/${agencyId}/${id}.webp`;
}

interface Item {
  /** The private upload, or null. */
  source: string | null;
  /** Its public copy on the row now, or null. */
  current: string | null;
  /** May it be public now? */
  wanted: boolean;
  kind: 'agency-logos' | 'member-photos';
  maxBytes: number;
  opts: { px: number; cover: boolean };
  record: (tx: Tx, publicKey: string | null) => Promise<boolean>;
}

type Outcome = 'published' | 'removed' | 'unchanged' | 'stale' | 'unreadable';

async function reconcile(agencyId: string, item: Item, log?: Logger): Promise<Outcome> {
  const target = item.wanted && item.source ? portalImageKey(item.kind, agencyId, item.source) : null;
  if (target === item.current) return 'unchanged';
  let next = target;
  if (target && item.source) {
    const bytes = await storage().get('private', item.source, { maxBytes: item.maxBytes });
    let rendered: Uint8Array | null = null;
    if (bytes) {
      try {
        rendered = await withImageSlot(false, () => portalImage(bytes, item.opts));
      } catch (err) {
        if (!(err instanceof ImageInputError)) throw err;
        log?.warn({ agencyId, kind: item.kind }, 'portal image not readable: not published');
      }
    }
    if (rendered)
      await storage().put('media', target, rendered, { contentType: 'image/webp', cacheControl: PORTAL_IMAGE_CACHE });
    else next = null;
  }
  // S15-F10 review: the copy that goes is deleted before its row stops naming it (a missing object counts as
  // deleted). A failed delete throws, the row still names the copy, and the job's retry deletes it again — clearing the
  // row first would leave a public copy nothing points at, for ever.
  if (item.current && item.current !== next) await storage().delete('media', item.current);
  const recorded = await withSystem('media.publishPortalImages', async (tx) => {
    if (!(await item.record(tx, next))) return false;
    // S15-F10 review: the agency's cached portal pages show the new copy (or drop the removed one).
    if (next !== item.current) await emit(tx, mediaEvents.portalImagesChanged({ agencyId, kind: item.kind }));
    return true;
  });
  if (!recorded) {
    // The row changed meanwhile (a new upload, or liveness lost): its own event runs this again; the copy made here
    // goes. A failed delete throws so the job retries rather than leaving it public.
    if (next) await storage().delete('media', next);
    return 'stale';
  }
  if (target && !next) return 'unreadable';
  return next ? 'published' : 'removed';
}

export interface PortalImagesResult {
  logo: Outcome | 'none';
  photos: Record<Outcome, number>;
}

/** Reconciles one agency's portal images (see the file comment). Network I/O outside every transaction. */
export async function publishPortalImages(agencyId: string, opts: { log?: Logger } = {}): Promise<PortalImagesResult> {
  const l = await withSystem('media.publishPortalImages', (tx) => agencies.portalLogoState(tx, agencyId));
  const photos: Record<Outcome, number> = { published: 0, removed: 0, unchanged: 0, stale: 0, unreadable: 0 };
  const listed = l?.listed === true;
  let logo: PortalImagesResult['logo'] = 'none';
  if (l && (l.logoStorageKey || l.logoPublicKey)) {
    logo = await reconcile(
      agencyId,
      {
        source: l.logoStorageKey,
        current: l.logoPublicKey,
        wanted: listed,
        kind: 'agency-logos',
        maxBytes: AGENCY_LOGO_MAX_BYTES,
        opts: { px: PORTAL_LOGO_PX, cover: false },
        record: (tx, key) => agencies.setLogoPublicKey(tx, agencyId, l.logoStorageKey, key),
      },
      opts.log,
    );
  }
  // S15-F10 review: every profile with a photo, a page per statement (keyset on user id), one image at a time — each
  // holds an image slot while it renders.
  let after: string | null = null;
  for (;;) {
    const cursor: string | null = after;
    const page: identity.MemberPhotoState[] = await withSystem('media.publishPortalImages', (tx) =>
      identity.memberPhotoStates(tx, agencyId, { after: cursor, limit: PORTAL_PHOTO_PAGE }),
    );
    for (const p of page) {
      const outcome = await reconcile(
        agencyId,
        {
          source: p.photoStorageKey,
          current: p.photoPublicKey,
          wanted: listed && p.live,
          kind: 'member-photos',
          maxBytes: MEMBER_PHOTO_MAX_BYTES,
          opts: { px: PORTAL_PHOTO_PX, cover: true },
          record: (tx, key) => identity.setMemberPhotoPublicKey(tx, agencyId, p.userId, p.photoStorageKey, key),
        },
        opts.log,
      );
      photos[outcome]++;
    }
    if (page.length < PORTAL_PHOTO_PAGE) break;
    after = page[page.length - 1]?.userId ?? null;
  }
  return { logo, photos };
}
