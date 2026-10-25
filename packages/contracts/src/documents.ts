import { z } from 'zod';
import { ContentLocaleCode } from './properties';

/**
 * PDF documents (S12-05, PLAN §7 M13): a branded brochure of one listing, a portfolio of several, rendered by the `pdf`
 * worker pool and handed out as short signed links. Listings appear as the agency presents them to a client: public
 * read models (prices and status as they are now), white-labelled (another agency's listing carries no owner).
 */

/** Listings one portfolio holds at most (one page each, plus the cover). */
export const PORTFOLIO_LISTINGS_MAX = 50;

/** A document id: the hash of what it shows (the same request on unchanged listings is the same document). */
export const PdfDocumentId = z.string().regex(/^[0-9a-f]{32}$/);

export const PdfDocumentKind = z.enum(['BROCHURE', 'PORTFOLIO']);
export type PdfDocumentKind = z.infer<typeof PdfDocumentKind>;

/** `POST /v1/documents/brochures`: one listing (own, or a network listing the agency may show). */
export const CreateBrochureBody = z.strictObject({
  listingId: z.uuid(),
  /** The client's language (a content locale); default: the agency's first. */
  locale: ContentLocaleCode.optional(),
});
export type CreateBrochureBody = z.infer<typeof CreateBrochureBody>;

/** `POST /v1/documents/portfolios`: several listings, in this order. */
export const CreatePortfolioBody = z.strictObject({
  listingIds: z
    .array(z.uuid())
    .min(1)
    .max(PORTFOLIO_LISTINGS_MAX)
    .refine((ids) => new Set(ids).size === ids.length, 'duplicate'),
  locale: ContentLocaleCode.optional(),
  /** The cover's title (plain text). */
  title: z.string().trim().min(1).max(120).optional(),
});
export type CreatePortfolioBody = z.infer<typeof CreatePortfolioBody>;

export const PdfDocumentParams = z.strictObject({ documentId: PdfDocumentId });
export type PdfDocumentParams = z.infer<typeof PdfDocumentParams>;

export const PdfDocumentStatus = z.enum(['PENDING', 'READY', 'FAILED']);
export type PdfDocumentStatus = z.infer<typeof PdfDocumentStatus>;

export const PdfDocumentDto = z.strictObject({
  id: PdfDocumentId,
  status: PdfDocumentStatus,
  /** A signed download link while `READY` (short-lived: fetch the document again for a new one); null otherwise. */
  url: z.string().nullable(),
  /** When `url` stops working (ISO); null without a link. */
  urlExpiresAt: z.iso.datetime().nullable(),
});
export type PdfDocumentDto = z.infer<typeof PdfDocumentDto>;
