/**
 * `pdf` pool jobs (S12-05). Fair share per agency: at most `DOCUMENT_RENDERS_PER_AGENCY` renders of one agency run
 * at once across the pool (one agency's burst of portfolios waits behind its own cap, never other agencies'), and a
 * worker process renders at most `PDF_RENDER_CONCURRENCY` documents at once (`perProcessConcurrency`, the browser's
 * page pool — both job kinds share it through `capGroup`). Idempotent: the job id is the document id (the request's
 * content), and a stored document is not rendered again. No schedule.
 */
import { defineJob, isPermanent } from '@inmolink/platform/queue';
import { z } from 'zod';
import * as crm from '../crm';
import { DOCUMENT_RENDERS_PER_AGENCY, documentsSettings } from './config';
import { eraseContactForms, failFormDocument, renderFormDocument, repointContactForms } from './forms';
import { ListingsDocumentPayload, ViewingTermsPayload } from './payloads';
import { renderListingsDocument, renderViewingTermsDocument } from './render';
import {
  applySignatureEvent,
  failSignatureSeal,
  inviteSigners,
  notifySignatureCompleted,
  sealSignatureRequest,
  sendSigningCode,
} from './signatures';

const RENDER_CAPS = {
  concurrencyPerGroup: DOCUMENT_RENDERS_PER_AGENCY,
  perProcessConcurrency: () => documentsSettings().renderConcurrency,
  capGroup: 'documents.render',
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  timeoutMs: 120_000,
} as const;

export const documentsJobs = {
  renderListings: defineJob({
    name: 'documents.renderListings',
    pool: 'pdf',
    payload: ListingsDocumentPayload,
    jobId: (p) => p.documentId,
    group: (p) => p.agencyId,
    ...RENDER_CAPS,
    async run(p, ctx) {
      return renderListingsDocument(p, { signal: ctx.signal });
    },
  }),

  renderViewingTerms: defineJob({
    name: 'documents.renderViewingTerms',
    pool: 'pdf',
    payload: ViewingTermsPayload,
    jobId: (p) => p.requestId,
    group: (p) => p.ownerAgencyId,
    ...RENDER_CAPS,
    async run(p, ctx) {
      return renderViewingTermsDocument(p, { signal: ctx.signal });
    },
  }),

  /**
   * R2-05a: a made form, rendered once (`renderFormDocument`: PENDING → READY with the PDF's hash). The job id is the
   * form id. A render that fails for good (last attempt, or permanent) leaves the form `FAILED`.
   */
  renderForm: defineJob({
    name: 'documents.renderForm',
    pool: 'pdf',
    payload: z.object({ formId: z.uuid(), agencyId: z.uuid() }),
    jobId: (p) => p.formId,
    group: (p) => p.agencyId,
    ...RENDER_CAPS,
    async run(p, ctx) {
      try {
        // the event's agency (RLS-checked) must own the form: renderFormDocument checks the row's
        return await renderFormDocument(p.formId, p.agencyId, { signal: ctx.signal });
      } catch (err) {
        if (isPermanent(err) || ctx.attempt >= RENDER_CAPS.attempts) await failFormDocument(p.formId);
        throw err;
      }
    },
  }),

  /** R2-05a: a merged contact's forms follow the survivor (its data export and list filter find them). Idempotent. */
  repointContactForms: defineJob({
    name: 'documents.repointContactForms',
    pool: 'maintenance',
    payload: z.object({ eventId: z.uuid(), agencyId: z.uuid(), survivorId: z.uuid(), mergedId: z.uuid() }),
    jobId: (p) => `forms-repoint:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 60_000,
    async run(p) {
      return { moved: await repointContactForms(p) };
    },
  }),

  /** R2-05a: an erased contact's (and its merged contacts') forms are deleted, PDFs first. Idempotent. */
  eraseContactForms: defineJob({
    name: 'documents.eraseContactForms',
    pool: 'maintenance',
    payload: z.object({ eventId: z.uuid(), agencyId: z.uuid(), contactId: z.uuid() }),
    jobId: (p) => `forms-erase:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 60_000,
    async run(p) {
      const contactIds = await crm.erasedContactIds({ agencyId: p.agencyId, contactIds: [p.contactId] });
      return { deleted: await eraseContactForms({ agencyId: p.agencyId, contactIds }) };
    },
  }),

  // ── R2-05b, e-signature ─────────────────────────────────────────────────────────────────────────────

  /** Supersedes the form's earlier open requests, invites the signers whose turn it is (job id = the event). */
  inviteSigners: defineJob({
    name: 'documents.inviteSigners',
    pool: 'email',
    payload: z.object({ eventId: z.uuid(), agencyId: z.uuid(), requestId: z.uuid() }),
    jobId: (p) => `sign-invite:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 60_000,
    async run(p) {
      return inviteSigners(p);
    },
  }),

  /** E-mails a one-time code while its row lives (job id = the code's row). */
  sendSigningCode: defineJob({
    name: 'documents.sendSigningCode',
    pool: 'email',
    payload: z.object({ agencyId: z.uuid(), signerId: z.uuid(), otpId: z.uuid() }),
    jobId: (p) => `sign-code:${p.otpId}`,
    group: (p) => p.agencyId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 30_000,
    async run(p) {
      return { sent: await sendSigningCode(p) };
    },
  }),

  /** Applies a signature from the signer's SIGNED page action (job id = that action). */
  applySignature: defineJob({
    name: 'documents.applySignature',
    pool: 'maintenance',
    payload: z.object({ agencyId: z.uuid(), signerId: z.uuid(), eventId: z.uuid() }),
    jobId: (p) => `sign-apply:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 60_000,
    async run(p) {
      return { result: await applySignatureEvent(p) };
    },
  }),

  /**
   * Seals the signed PDF (original + audit trail) once everyone signed (job id = the request). A seal that fails for
   * good (last attempt, or permanent: the original changed, a PDF the provider cannot read) leaves the request FAILED.
   */
  sealSignature: defineJob({
    name: 'documents.sealSignature',
    pool: 'pdf',
    payload: z.object({ agencyId: z.uuid(), requestId: z.uuid() }),
    jobId: (p) => `sign-seal:${p.requestId}`,
    group: (p) => p.agencyId,
    ...RENDER_CAPS,
    async run(p, ctx) {
      try {
        return await sealSignatureRequest(p, { signal: ctx.signal });
      } catch (err) {
        if (isPermanent(err) || ctx.attempt >= RENDER_CAPS.attempts) await failSignatureSeal(p.requestId);
        throw err;
      }
    },
  }),

  /** Tells the signers and the requester (the signed PDF's link and hash; job id = the request). */
  notifySignatureCompleted: defineJob({
    name: 'documents.notifySignatureCompleted',
    pool: 'email',
    payload: z.object({ agencyId: z.uuid(), requestId: z.uuid() }),
    jobId: (p) => `sign-done:${p.requestId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 60_000,
    async run(p) {
      return { sent: await notifySignatureCompleted(p) };
    },
  }),
};
