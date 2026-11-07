import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * documents events (PATTERNS §8).
 *
 * - `documents.form.created` (R2-05a) — a member made a form document (`PENDING`): its render is queued
 *   (`subscriptions.ts`). Ids only.
 * - R2-05b, e-signature (ids only, never a name, address or code):
 *   - `documents.signature.requested` — a member asked for signatures (or a signer of an ordered request signed): the
 *     signers whose turn it is are invited, earlier open requests of the form superseded.
 *   - `documents.signature.codeRequested` — a signer asked for a one-time code on the signing page (appended by the
 *     public pages as `app_intake`): the worker e-mails it.
 *   - `documents.signature.signed` — a signer signed on the page (`app_intake`): the worker applies it.
 *   - `documents.signature.allSigned` — everyone signed: the signed PDF is sealed (`pdf` pool).
 *   - `documents.signature.completed` — the signed PDF is stored: the signers and the requester are told.
 */
export const documentsEvents = {
  formCreated: defineEvent('documents.form.created', 1, z.object({ agencyId: z.uuid(), formId: z.uuid() })),
  signatureRequested: defineEvent(
    'documents.signature.requested',
    1,
    z.object({ agencyId: z.uuid(), requestId: z.uuid() }),
  ),
  signatureCodeRequested: defineEvent(
    'documents.signature.codeRequested',
    1,
    z.object({ agencyId: z.uuid(), signerId: z.uuid(), otpId: z.uuid() }),
  ),
  signatureSigned: defineEvent(
    'documents.signature.signed',
    1,
    z.object({ agencyId: z.uuid(), signerId: z.uuid(), eventId: z.uuid() }),
  ),
  signatureAllSigned: defineEvent(
    'documents.signature.allSigned',
    1,
    z.object({ agencyId: z.uuid(), requestId: z.uuid() }),
  ),
  signatureCompleted: defineEvent(
    'documents.signature.completed',
    1,
    z.object({ agencyId: z.uuid(), requestId: z.uuid() }),
  ),
};
