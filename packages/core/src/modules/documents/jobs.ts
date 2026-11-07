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
};
