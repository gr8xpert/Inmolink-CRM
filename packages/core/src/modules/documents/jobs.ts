/**
 * `pdf` pool jobs (S12-05). Fair share per agency: at most `DOCUMENT_RENDERS_PER_AGENCY` renders of one agency run
 * at once across the pool (one agency's burst of portfolios waits behind its own cap, never other agencies'), and a
 * worker process renders at most `PDF_RENDER_CONCURRENCY` documents at once (`perProcessConcurrency`, the browser's
 * page pool — both job kinds share it through `capGroup`). Idempotent: the job id is the document id (the request's
 * content), and a stored document is not rendered again. No schedule.
 */
import { defineJob } from '@inmolink/platform/queue';
import { DOCUMENT_RENDERS_PER_AGENCY, documentsSettings } from './config';
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
};
