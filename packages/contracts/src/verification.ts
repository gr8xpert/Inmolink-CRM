import { z } from 'zod';
import { AgencyDto } from './agencies';
import { Cursor, pageOf } from './common';

/**
 * Agency verification DTOs (S1-03, PLAN §3 #3). The agency uploads documents and submits its
 * details; staff approve or reject with a reason. VERIFIED unlocks SHARED/PUBLIC listings and API keys.
 */

export const VerificationDocumentKind = z.enum(['TAX_ID', 'BUSINESS_PROOF', 'REGISTER', 'OTHER']);
export type VerificationDocumentKind = z.infer<typeof VerificationDocumentKind>;

export const VerificationRequestStatus = z.enum(['SUBMITTED', 'APPROVED', 'REJECTED']);
export type VerificationRequestStatus = z.infer<typeof VerificationRequestStatus>;

/** Upload cap per document (PDF scans, photos of a certificate). */
export const VERIFICATION_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
/** Documents an agency may hold before submitting. */
export const VERIFICATION_DOCUMENT_MAX_COUNT = 10;
/** Types accepted, detected from magic bytes (the client's header only routes the body). */
export const VERIFICATION_DOCUMENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const;

/** Display name: shown to staff and used as the download name, so no paths, controls or markup. */
export const DocumentFileName = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[^\p{Cc}<>/\\:"*?|]+$/u, 'no control characters, paths or < > : " * ? |');

/** `POST /v1/agency/verification/documents?kind=&fileName=` — the body is the raw file. */
export const UploadVerificationDocumentQuery = z
  .object({ kind: VerificationDocumentKind, fileName: DocumentFileName })
  .strict();
export type UploadVerificationDocumentQuery = z.infer<typeof UploadVerificationDocumentQuery>;

export const VerificationDocumentDto = z.object({
  id: z.uuid(),
  kind: VerificationDocumentKind,
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  /** Attached to a submitted request: kept as evidence, no longer deletable. */
  submitted: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type VerificationDocumentDto = z.infer<typeof VerificationDocumentDto>;

export const VerificationRequestSummaryDto = z.object({
  id: z.uuid(),
  status: VerificationRequestStatus,
  submittedAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
  /** Staff's reason — what to fix after a rejection. */
  decisionReason: z.string().nullable(),
});
export type VerificationRequestSummaryDto = z.infer<typeof VerificationRequestSummaryDto>;

/** `GET /v1/agency/verification` — where the agency stands. */
export const AgencyVerificationDto = z.object({
  agencyStatus: AgencyDto.shape.status,
  onboarded: z.boolean(),
  /** The details `version` a submission confirms. */
  agencyVersion: z.number().int(),
  /** Documents not yet submitted, then those of the latest request. */
  documents: z.array(VerificationDocumentDto),
  latestRequest: VerificationRequestSummaryDto.nullable(),
});
export type AgencyVerificationDto = z.infer<typeof AgencyVerificationDto>;

/** `POST /v1/agency/verification` — submit the details shown at `version` with the uploaded documents. */
export const SubmitVerificationBody = z.object({ version: z.number().int().positive() }).strict();
export type SubmitVerificationBody = z.infer<typeof SubmitVerificationBody>;

export const DocumentParams = z.object({ id: z.uuid() }).strict();

// ── Staff ──────────────────────────────────────────────────────────────────────────────────────

/** `GET /v1/staff/verification-requests` — oldest first (first come, first served). */
export const VerificationQueueQuery = z
  .object({
    status: VerificationRequestStatus.default('SUBMITTED'),
    cursor: Cursor.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type VerificationQueueQuery = z.infer<typeof VerificationQueueQuery>;

export const VerificationQueueItemDto = z.object({
  id: z.uuid(),
  status: VerificationRequestStatus,
  submittedAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
  agency: z.object({ id: z.uuid(), name: z.string(), kind: AgencyDto.shape.kind, taxId: z.string().nullable() }),
});
export type VerificationQueueItemDto = z.infer<typeof VerificationQueueItemDto>;

export const VerificationQueuePage = pageOf(VerificationQueueItemDto);
export type VerificationQueuePage = z.infer<typeof VerificationQueuePage>;

export const VerificationRequestParams = z.object({ id: z.uuid() }).strict();
export const VerificationDocumentParams = z.object({ id: z.uuid(), documentId: z.uuid() }).strict();

/** One request for review: the agency's current details (with `version`) and the submitted documents. */
export const VerificationRequestDto = z.object({
  id: z.uuid(),
  status: VerificationRequestStatus,
  submittedAt: z.iso.datetime(),
  /** `agency.version` when the agency submitted; differs from `agency.version` if it edited since. */
  detailsVersion: z.number().int(),
  decidedAt: z.iso.datetime().nullable(),
  decisionReason: z.string().nullable(),
  reviewerUserId: z.uuid().nullable(),
  reviewedVersion: z.number().int().nullable(),
  agency: AgencyDto,
  documents: z.array(VerificationDocumentDto),
});
export type VerificationRequestDto = z.infer<typeof VerificationRequestDto>;

/**
 * Reason text: shown to the agency in an email and on its verification page. Line breaks from the
 * staff textarea are kept (normalized to LF); other control characters and < > are refused.
 */
export const DecisionReason = z
  .string()
  .transform((v) => v.replace(/\r\n?/g, '\n').trim())
  .pipe(
    z
      .string()
      .min(3)
      .max(1000)
      .regex(/^(?:[^\p{Cc}<>]|\n)*$/u, 'no control characters (except line breaks) or < >'),
  );

/**
 * `POST /v1/staff/verification-requests/:id/decision`. `agencyVersion` is the details version staff
 * reviewed; the decision is refused (`VERIFICATION_STALE`) if the agency changed since.
 */
export const DecideVerificationBody = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    agencyVersion: z.number().int().positive(),
    reason: DecisionReason,
  })
  .strict();
export type DecideVerificationBody = z.infer<typeof DecideVerificationBody>;

/** A short-lived download link for one document. */
export const SignedUrlDto = z.object({ url: z.url(), expiresAt: z.iso.datetime() });
export type SignedUrlDto = z.infer<typeof SignedUrlDto>;
