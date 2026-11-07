import { z } from 'zod';
import { PORTFOLIO_LISTINGS_MAX } from './documents';
import { ContentLocaleCode } from './properties';

/**
 * Window cards (R2-06, PLAN §7 M13): one printable card per listing — A4 or A3, portrait or landscape — with the
 * agency's branding and a QR code to the listing's live, branded page. A batch (up to `WINDOW_CARDS_MAX` listings) is
 * one worker job and one PDF (or HTML) file, one page per card. The documents read like any client-facing output:
 * public read models, white-labelled (no owner, commission or owner contact).
 */

/** Cards one batch holds at most (one page each). */
export const WINDOW_CARDS_MAX = PORTFOLIO_LISTINGS_MAX;

export const WINDOW_CARD_SIZES = ['A4', 'A3'] as const;
export const WINDOW_CARD_ORIENTATIONS = ['PORTRAIT', 'LANDSCAPE'] as const;
/** Page layouts; the template ids below are a layout in a paper size and orientation. */
export const WINDOW_CARD_LAYOUTS = ['classic', 'split', 'gallery', 'bold'] as const;
export type WindowCardLayout = (typeof WINDOW_CARD_LAYOUTS)[number];

export interface WindowCardTemplate {
  id: string;
  layout: WindowCardLayout;
  size: (typeof WINDOW_CARD_SIZES)[number];
  orientation: (typeof WINDOW_CARD_ORIENTATIONS)[number];
}

const T = (
  layout: WindowCardLayout,
  size: WindowCardTemplate['size'],
  orientation: WindowCardTemplate['orientation'],
): WindowCardTemplate => ({
  id: `${layout}-${size.toLowerCase()}-${orientation === 'PORTRAIT' ? 'p' : 'l'}`,
  layout,
  size,
  orientation,
});

/** The templates at launch (12). */
export const WINDOW_CARD_TEMPLATES: readonly WindowCardTemplate[] = [
  T('classic', 'A4', 'PORTRAIT'),
  T('classic', 'A4', 'LANDSCAPE'),
  T('classic', 'A3', 'PORTRAIT'),
  T('classic', 'A3', 'LANDSCAPE'),
  T('split', 'A4', 'LANDSCAPE'),
  T('split', 'A4', 'PORTRAIT'),
  T('split', 'A3', 'LANDSCAPE'),
  T('gallery', 'A4', 'PORTRAIT'),
  T('gallery', 'A3', 'PORTRAIT'),
  T('gallery', 'A4', 'LANDSCAPE'),
  T('bold', 'A4', 'PORTRAIT'),
  T('bold', 'A3', 'LANDSCAPE'),
];

export const WindowCardTemplateId = z.enum(WINDOW_CARD_TEMPLATES.map((t) => t.id) as [string, ...string[]]);
export type WindowCardTemplateId = z.infer<typeof WindowCardTemplateId>;

export const WindowCardFormat = z.enum(['PDF', 'HTML']);
export type WindowCardFormat = z.infer<typeof WindowCardFormat>;

/** `POST /v1/window-cards`: the listings (in this order), one template, the output format. */
export const CreateWindowCardsBody = z.strictObject({
  listingIds: z
    .array(z.uuid())
    .min(1)
    .max(WINDOW_CARDS_MAX)
    .refine((ids) => new Set(ids).size === ids.length, 'duplicate'),
  template: WindowCardTemplateId,
  format: WindowCardFormat.default('PDF'),
  /** The cards' language (a content locale); default: the agency's first. */
  locale: ContentLocaleCode.optional(),
});
export type CreateWindowCardsBody = z.input<typeof CreateWindowCardsBody>;
