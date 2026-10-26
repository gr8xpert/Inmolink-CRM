import type { WebsiteImage } from '@inmolink/contracts';

/**
 * The media pipeline's WebP variants as pages use them (S7-F8 embeds, S12-04 selections, S15-01 portal): their widths
 * (longest side; core `media/variants.ts`) and an image's `srcset`.
 */
export const VARIANT_WIDTHS = { thumb: 320, small: 640, medium: 1280, large: 2048 } as const;

/** An image's `srcset` over its variants (undefined: none). */
export function srcSet(image: WebsiteImage): string | undefined {
  const parts = (Object.keys(VARIANT_WIDTHS) as (keyof typeof VARIANT_WIDTHS)[])
    .filter((k) => image.urls[k])
    .map((k) => `${image.urls[k]} ${VARIANT_WIDTHS[k]}w`);
  return parts.length > 0 ? parts.join(', ') : undefined;
}
