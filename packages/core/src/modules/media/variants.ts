/**
 * Media variant keys (S3-04, PLAN §3 #33): deterministic, so nothing stores a row per variant. A stored
 * object (`media_objects`, by SHA-256) has one private normalized master and, per pipeline version, a fixed set
 * of variants under `v{pipeline}/{publicId}/{size}.{ext}`; `variants_ready` says which of them exist (one bit
 * per size). Read models build URLs from the hash alone.
 *
 * `publicId` is an HMAC of the hash, not the hash: a public URL must not let anyone link white-labelled sites
 * to the owner's original upload, or attach a stored object by its hash (S3-03 Decisions). The key is
 * `MEDIA_URL_KEY`, never rotated with `HMAC_KEY`: a new key changes every public key (and the cleanup could no
 * longer find the old variants), so a rotation needs a migration job that moves them.
 *
 * Only variants live in the `media` bucket (they are what browsers and CDNs read); originals and masters stay
 * in the `private` bucket.
 */
import { hmacSha256Hex } from '@inmolink/platform/crypto';

/** Bump when any variant's size, format or encoder settings change: every key changes with it. */
export const MEDIA_PIPELINE_VERSION = 1;

/** The normalized master's longest side. */
export const MASTER_MAX_PX = 2560;

type WebpVariant = { bit: number; format: 'webp'; maxPx: number };
type JpegVariant = { bit: number; format: 'jpeg'; width: number; height: number };

/**
 * The sizes of the current pipeline. WebP variants fit inside a `maxPx` square and never enlarge; `og` is the
 * JPEG cover for link previews (Open Graph wants 1200 × 630 and JPEG is the safe choice for every crawler).
 */
export const VARIANTS = {
  thumb: { bit: 1, format: 'webp', maxPx: 320 },
  small: { bit: 2, format: 'webp', maxPx: 640 },
  medium: { bit: 4, format: 'webp', maxPx: 1280 },
  large: { bit: 8, format: 'webp', maxPx: 2048 },
  og: { bit: 16, format: 'jpeg', width: 1200, height: 630 },
} as const satisfies Record<string, WebpVariant | JpegVariant>;

export type VariantName = keyof typeof VARIANTS;
export const VARIANT_NAMES = Object.keys(VARIANTS) as VariantName[];
export const ALL_VARIANTS_MASK = VARIANT_NAMES.reduce((m, n) => m | VARIANTS[n].bit, 0);

export const variantsMask = (names: readonly VariantName[]) => names.reduce((m, n) => m | VARIANTS[n].bit, 0);
export const variantsIn = (mask: number) => VARIANT_NAMES.filter((n) => (mask & VARIANTS[n].bit) !== 0);

let urlKey: Buffer | undefined;

/** Called once at boot by every app that builds variant keys (the worker; read models later). */
export function configureMedia(config: { urlKey: string }): void {
  urlKey = Buffer.from(config.urlKey);
}

/** The public name of a stored object in variant keys (128 bits of an HMAC of its hash). */
export function mediaPublicId(sha256: string): string {
  if (!urlKey) throw new Error('media is not configured (call configureMedia at boot)');
  return hmacSha256Hex(urlKey, 'media.variant', sha256).slice(0, 32);
}

/** The normalized master of a stored object, in the `private` bucket (never served). */
export const masterKey = (sha256: string) => `masters/${sha256}`;

const EXT = { webp: 'webp', jpeg: 'jpg' } as const;

/** `v{pipeline}/{publicId}/{size}.{ext}`: the same object, size and pipeline always give the same key. */
export function variantKey(sha256: string, name: VariantName, pipeline = MEDIA_PIPELINE_VERSION): string {
  return `v${pipeline}/${mediaPublicId(sha256)}/${name}.${EXT[VARIANTS[name].format]}`;
}
