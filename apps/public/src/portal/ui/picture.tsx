import type { WebsiteImage } from '@inmolink/contracts';
import { preload } from 'react-dom';
import { srcSet } from '@/media/variants';

/**
 * A listing photo from its CDN variants (srcset + sizes, never the original). `eager` only for the page's first
 * visible photo (the LCP element): it loads with high priority and decodes with the page.
 */
export function Photo(props: { image: WebsiteImage; alt: string; sizes: string; eager?: boolean; className?: string }) {
  const src = props.image.urls.small ?? props.image.urls.medium ?? props.image.urls.thumb ?? props.image.urls.large;
  if (!src) return null;
  const set = srcSet(props.image);
  // The page's LCP image: a preload in the head, so the browser fetches it with the document, before the body's
  // markup (the filters, the intro) is parsed.
  if (props.eager) preload(src, { as: 'image', imageSrcSet: set, imageSizes: props.sizes, fetchPriority: 'high' });
  return (
    // biome-ignore lint/performance/noImgElement: CDN variants with srcset; next/image would proxy them again.
    <img
      src={src}
      srcSet={set}
      sizes={props.sizes}
      alt={props.alt}
      width={props.image.width}
      height={props.image.height}
      loading={props.eager ? 'eager' : 'lazy'}
      fetchPriority={props.eager ? 'high' : undefined}
      decoding={props.eager ? undefined : 'async'}
      className={props.className}
    />
  );
}

/**
 * `sizes` capped so a phone takes the 640w variant, not 1280w (no 960w variant exists; the embeds' rule): a 412 px
 * screen at DPR 1.75 needs 630 px for 360 CSS px. Desktops: a 288 px card takes 320–640w, the hero 1280w.
 */
export const CARD_SIZES = '(min-width: 640px) 288px, 360px';
export const HERO_SIZES = '(min-width: 1024px) 760px, (min-width: 640px) 100vw, 360px';
export const THUMB_SIZES = '(min-width: 1024px) 380px, 180px';
