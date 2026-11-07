import { z } from 'zod';
import { PageQuery, pageOf } from './common';
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

// ---- R2-05a: the forms library -------------------------------------------------------------------------------------

/**
 * The forms library (R2-05a, PLAN §7 M13): branded, multilingual documents merged from the agency's data — parties,
 * property, prices and commission as stored, never written by AI. Rendered once by the `pdf` pool; the stored PDF's
 * SHA-256 is what a signature (R2-05b) is made over. The clause texts are placeholders pending lawyer review (STATUS
 * Decisions, H17): every document says so on its face.
 */
export const FORM_TEMPLATES = [
  'LISTING_AGREEMENT',
  'RESERVATION',
  'VIEWING_SHEET',
  'OFFER',
  'COLLABORATION_AGREEMENT',
] as const;
export const FormTemplate = z.enum(FORM_TEMPLATES);
export type FormTemplate = z.infer<typeof FormTemplate>;

/** Who signs each template, in order (the document's signature blocks; R2-05b, the dashboard's signer roles R2-05c). */
export const FORM_SIGNER_ROLES: Readonly<Record<FormTemplate, readonly string[]>> = {
  LISTING_AGREEMENT: ['seller', 'agency'],
  RESERVATION: ['buyer', 'agency'],
  VIEWING_SHEET: ['buyer', 'agency'],
  OFFER: ['buyer', 'agency'],
  COLLABORATION_AGREEMENT: ['ownerAgency', 'introducerAgency'],
};

/** Properties one viewing sheet lists at most. */
export const VIEWING_SHEET_LISTINGS_MAX = 20;
/** The currency of a generated form's amounts when no listing names one (the agencies' market: Spain). */
export const FORM_DEFAULT_CURRENCY = 'EUR';
/** The largest amount a form takes (a price, a deposit, an offer): 1,000,000,000.00 in cents. */
export const FORM_AMOUNT_MAX_CENTS = 100_000_000_000;

const FormAmount = z.strictObject({
  amountCents: z.number().int().min(1).max(FORM_AMOUNT_MAX_CENTS),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

const formBase = {
  /** The document's language (a content locale); default: the agency's first. */
  locale: ContentLocaleCode.optional(),
};

/**
 * `POST /v1/documents/forms` (the collaboration agreement is made from its deal: `POST /v1/mls/deals/:id/collaboration-agreement`).
 * The listing is the agency's own; the contact is the agency's (the seller of a listing agreement, else the buyer).
 * Accepts `Idempotency-Key`.
 */
export const CreateFormDocumentBody = z.discriminatedUnion('template', [
  z.strictObject({
    template: z.literal('LISTING_AGREEMENT'),
    ...formBase,
    listingId: z.uuid(),
    contactId: z.uuid(),
    exclusive: z.boolean(),
    /** How long the mandate runs. */
    termMonths: z.number().int().min(1).max(36),
  }),
  z.strictObject({
    template: z.literal('RESERVATION'),
    ...formBase,
    listingId: z.uuid(),
    contactId: z.uuid(),
    /** The agreed price; default: the listing's price. */
    price: FormAmount.optional(),
    deposit: FormAmount,
    /** Days the property is held off the market for the buyer. */
    holdDays: z.number().int().min(1).max(180),
  }),
  z.strictObject({
    template: z.literal('VIEWING_SHEET'),
    ...formBase,
    contactId: z.uuid(),
    listingIds: z
      .array(z.uuid())
      .min(1)
      .max(VIEWING_SHEET_LISTINGS_MAX)
      .refine((ids) => new Set(ids).size === ids.length, 'duplicate'),
    visitedOn: z.iso.date(),
  }),
  z.strictObject({
    template: z.literal('OFFER'),
    ...formBase,
    listingId: z.uuid(),
    contactId: z.uuid(),
    offer: FormAmount,
    validUntil: z.iso.date(),
    /**
     * The buyer's conditions, as the agent typed them (plain text): control and invisible formatting characters (bidi
     * overrides) become spaces, line breaks stay — a signable text reads as it is stored.
     */
    conditions: z
      .string()
      .max(2_000)
      .transform((s) =>
        s.replace(/[\p{Cc}\p{Zl}\p{Zp}]|[^\P{Cf}\p{Join_Control}]/gu, (c) => (c === '\n' ? c : ' ')).trim(),
      )
      .pipe(z.string().min(1).max(1_000))
      .optional(),
  }),
]);
export type CreateFormDocumentBody = z.infer<typeof CreateFormDocumentBody>;

/** `POST /v1/mls/deals/:id/collaboration-agreement`: both agencies, the property, price and commission from the deal. */
export const CreateCollaborationAgreementBody = z.strictObject({ ...formBase });
export type CreateCollaborationAgreementBody = z.infer<typeof CreateCollaborationAgreementBody>;

export const FormDocumentParams = z.strictObject({ id: z.uuid() });
export type FormDocumentParams = z.infer<typeof FormDocumentParams>;

/** `GET /v1/documents/forms`: the agency's forms, newest first; optionally one template, contact, listing or deal. */
export const ListFormDocumentsQuery = PageQuery.extend({
  template: FormTemplate.optional(),
  contactId: z.uuid().optional(),
  listingId: z.uuid().optional(),
  dealId: z.uuid().optional(),
}).refine((q) => [q.contactId, q.listingId, q.dealId].filter((x) => x !== undefined).length <= 1, {
  message: 'at most one of contactId, listingId, dealId',
});
export type ListFormDocumentsQuery = z.infer<typeof ListFormDocumentsQuery>;

export const FormDocumentDto = z.strictObject({
  id: z.uuid(),
  template: FormTemplate,
  locale: z.string(),
  templateVersion: z.number().int(),
  status: PdfDocumentStatus,
  /** What the document is about: reference and party. */
  label: z.string(),
  listingId: z.uuid().nullable(),
  contactId: z.uuid().nullable(),
  dealId: z.uuid().nullable(),
  /** SHA-256 (hex) of the stored PDF, once `READY`. */
  sha256: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  createdByUserId: z.uuid(),
  createdAt: z.iso.datetime(),
  renderedAt: z.iso.datetime().nullable(),
  /**
   * The clause texts are placeholders pending lawyer review (R2-05a, H17): the document carries a "not for use with
   * clients" banner and the dashboard says so.
   */
  placeholder: z.boolean(),
  /** A short signed download link (`GET /v1/documents/forms/:id` once `READY`); null in lists and otherwise. */
  url: z.string().nullable(),
  urlExpiresAt: z.iso.datetime().nullable(),
});
export type FormDocumentDto = z.infer<typeof FormDocumentDto>;
export const FormDocumentPage = pageOf(FormDocumentDto);
export type FormDocumentPage = z.infer<typeof FormDocumentPage>;

// ── R2-05b, simple electronic signature ──────────────────────────────────────────────────────────────

/** People asked to sign one form at most. */
export const SIGNATURE_SIGNERS_MAX = 10;
/** How long a signing request stays open at most (days). */
export const SIGNATURE_EXPIRY_DAYS_MAX = 60;
/** How long a signing request stays open unless the member says otherwise (days). */
export const SIGNATURE_EXPIRY_DAYS_DEFAULT = 14;

export const SignatureSignerInput = z.strictObject({
  name: z.string().trim().min(1).max(200),
  email: z.email().max(254),
  /** The signature block they sign (the form template's signer roles, e.g. `buyer` and `agency`). */
  role: z.string().regex(/^[a-zA-Z]{1,32}$/),
  /** Their e-mails' and signing page's language (EN or ES); default: the form's. */
  locale: z
    .string()
    .regex(/^[a-z]{2}$/)
    .optional(),
});
export type SignatureSignerInput = z.infer<typeof SignatureSignerInput>;

/**
 * `POST /v1/documents/forms/:id/signature-requests`: ask these people to sign a READY form (its SHA-256 as stored).
 * `ordered`: they sign one after another, in the order given. A new request replaces the form's open one.
 */
export const CreateSignatureRequestBody = z.strictObject({
  signers: z.array(SignatureSignerInput).min(1).max(SIGNATURE_SIGNERS_MAX),
  ordered: z.boolean().default(false),
  expiresInDays: z.number().int().min(1).max(SIGNATURE_EXPIRY_DAYS_MAX).default(SIGNATURE_EXPIRY_DAYS_DEFAULT),
  message: z.string().trim().min(1).max(1000).optional(),
});
export type CreateSignatureRequestBody = z.input<typeof CreateSignatureRequestBody>;

export const SignatureRequestParams = z.strictObject({ id: z.uuid() });
export type SignatureRequestParams = z.infer<typeof SignatureRequestParams>;

/** `EXPIRED`: still open past its expiry (nobody can sign any more). */
export const SignatureRequestStatus = z.enum(['OPEN', 'SIGNED', 'COMPLETED', 'CANCELLED', 'FAILED', 'EXPIRED']);
export type SignatureRequestStatus = z.infer<typeof SignatureRequestStatus>;

export const SignatureSignerDto = z.strictObject({
  id: z.uuid(),
  position: z.number().int(),
  role: z.string(),
  name: z.string(),
  email: z.string(),
  locale: z.string(),
  invitedAt: z.iso.datetime().nullable(),
  signedAt: z.iso.datetime().nullable(),
  /** How they signed: `TYPED` (their name) or `DRAWN`; null until signed. */
  signatureKind: z.enum(['TYPED', 'DRAWN']).nullable(),
  /** The address they signed from (the audit trail's), once signed. */
  signedIp: z.string().nullable(),
});
export type SignatureSignerDto = z.infer<typeof SignatureSignerDto>;

export const SignatureRequestDto = z.strictObject({
  id: z.uuid(),
  formId: z.uuid(),
  provider: z.string(),
  status: SignatureRequestStatus,
  ordered: z.boolean(),
  /** SHA-256 of the form's PDF the signers signed. */
  documentSha256: z.string(),
  /** SHA-256 of the signed PDF (original + audit trail), once `COMPLETED`. */
  signedSha256: z.string().nullable(),
  signedSizeBytes: z.number().int().nullable(),
  message: z.string().nullable(),
  expiresAt: z.iso.datetime(),
  createdByUserId: z.uuid(),
  createdAt: z.iso.datetime(),
  allSignedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  signers: z.array(SignatureSignerDto),
  /** A short signed download link of the signed PDF (`GET …/signature-requests/:id` once `COMPLETED`); else null. */
  url: z.string().nullable(),
  urlExpiresAt: z.iso.datetime().nullable(),
});
export type SignatureRequestDto = z.infer<typeof SignatureRequestDto>;

export const SignatureRequestList = z.strictObject({ items: z.array(SignatureRequestDto) });
export type SignatureRequestList = z.infer<typeof SignatureRequestList>;

/** The largest PDF `POST …/verify` checks (25 MB). */
export const SIGNED_PDF_VERIFY_MAX_BYTES = 25 * 1024 * 1024;

/**
 * `POST /v1/documents/signature-requests/:id/verify` (raw PDF body): whether the file is the signed PDF (`SIGNED`) or
 * the original the signers signed (`ORIGINAL`) — byte for byte, by SHA-256 — or neither (`NONE`).
 */
export const VerifySignedPdfResult = z.strictObject({
  requestId: z.uuid(),
  match: z.enum(['SIGNED', 'ORIGINAL', 'NONE']),
  sha256: z.string(),
  documentSha256: z.string(),
  signedSha256: z.string().nullable(),
});
export type VerifySignedPdfResult = z.infer<typeof VerifySignedPdfResult>;

// ── R2-05c, the deal room's collaboration agreement signers ────────────────────────────────────────────

/** A signer role of the collaboration agreement: the party's signature block. */
export const DealSignerRole = z.enum(['ownerAgency', 'introducerAgency']);
export type DealSignerRole = z.infer<typeof DealSignerRole>;

export const DealSignerCandidate = z.strictObject({
  /** Who signs: the deal's signature request names its two signers by these. */
  userId: z.uuid(),
  name: z.string(),
  /**
   * The member's e-mail: in full for the caller's own agency; masked (`j***@agency.es`) for the other agency's — the
   * request takes the signer by `userId` and the server fills in the address, so a party never reads the other
   * agency's login addresses.
   */
  email: z.string(),
  /** The deal's member on that side (who asked for the viewing; the listing's agent); else one of its admins. */
  dealMember: z.boolean(),
});
export type DealSignerCandidate = z.infer<typeof DealSignerCandidate>;

/**
 * `GET /v1/mls/deals/:id/signers`: who may sign the deal's collaboration agreement for each party — the party's deal
 * member and its admins. The deal room offers them as the two signers; the deal's signature request accepts only these.
 */
export const DealSignersDto = z.strictObject({
  ownRole: DealSignerRole,
  own: z.array(DealSignerCandidate),
  counterpart: z.array(DealSignerCandidate),
});
export type DealSignersDto = z.infer<typeof DealSignersDto>;

/**
 * `POST /v1/mls/deals/:id/signature-requests`: ask both parties to sign the deal's collaboration agreement (`formId`):
 * one signer per agency, each one of `GET …/signers` by `userId` (names and addresses are the server's). Order,
 * expiry and message as `POST /v1/documents/forms/:id/signature-requests`. Accepts `Idempotency-Key`.
 */
export const CreateDealSignatureRequestBody = z.strictObject({
  formId: z.uuid(),
  ownUserId: z.uuid(),
  counterpartUserId: z.uuid(),
  ordered: z.boolean().default(false),
  expiresInDays: z.number().int().min(1).max(SIGNATURE_EXPIRY_DAYS_MAX).default(SIGNATURE_EXPIRY_DAYS_DEFAULT),
  message: z.string().trim().min(1).max(1000).optional(),
});
export type CreateDealSignatureRequestBody = z.input<typeof CreateDealSignatureRequestBody>;
