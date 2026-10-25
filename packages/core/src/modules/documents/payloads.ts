import { PdfDocumentId, PdfDocumentKind, PORTFOLIO_LISTINGS_MAX } from '@inmolink/contracts';
import { z } from 'zod';

/** Job payloads of the `pdf` pool (S12-05): ids and small parameters only (workers.md, < 10 KB). */

const Locale = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/);

/** A brochure or portfolio: the agency, its listings in order, the client's locale. */
export const ListingsDocumentPayload = z.object({
  documentId: PdfDocumentId,
  agencyId: z.uuid(),
  kind: PdfDocumentKind,
  locale: Locale,
  listingIds: z.array(z.uuid()).min(1).max(PORTFOLIO_LISTINGS_MAX),
  title: z.string().max(120).nullable(),
});
export type ListingsDocumentPayload = z.infer<typeof ListingsDocumentPayload>;

/** The accepted terms of a viewing request (S11-02), as mls read them when the owner accepted. */
export const ViewingTermsPayload = z.object({
  requestId: z.uuid(),
  /** The fair-share group (the accepting side). */
  ownerAgencyId: z.uuid(),
  locale: Locale,
  target: z.object({ ref: z.string().max(64).nullable(), title: z.string().max(300).nullable() }),
  introducerName: z.string().max(200),
  ownerName: z.string().max(200),
  commissionBp: z.number().int().nullable(),
  commissionFixed: z.object({ amountCents: z.number().int(), currency: z.string().length(3) }).nullable(),
  splitBp: z.number().int(),
  includesVat: z.boolean(),
  validUntil: z.iso.datetime(),
  snapshotAt: z.iso.datetime(),
  introducerAcceptedAt: z.iso.datetime(),
  ownerAcceptedAt: z.iso.datetime(),
  scheduledAt: z.iso.datetime().nullable(),
});
export type ViewingTermsPayload = z.infer<typeof ViewingTermsPayload>;
