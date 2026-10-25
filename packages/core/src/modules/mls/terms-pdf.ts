/**
 * `GET /v1/mls/viewing-requests/:id/terms` (S11-02, S12-05): the terms snapshot with its audit trail, and — once both
 * sides accepted and the accepted-terms PDF exists — a short signed link to it. The file check runs after the request's
 * transaction (object storage is a network call, CLAUDE.md rule 6). A PDF not there yet (it is rendered within seconds
 * of the owner's acceptance) or whose render failed: no link, and it is asked for again, at most once a minute per
 * request (`mls.queueViewingTermsPdf` → the pdf pool; both idempotent).
 */
import type { ViewingTermsDocumentDto } from '@inmolink/contracts';
import { newId } from '@inmolink/platform/ids';
import type { CtxRunner } from '../../context';
import * as documents from '../documents';
import { mlsJobs } from './jobs';
import { viewingTermsDoc } from './viewings';

const TERMS_PDF_RETRY_MS = 60_000;

export async function viewingTerms(run: CtxRunner, id: string): Promise<ViewingTermsDocumentDto> {
  const { doc, ownerAccepted } = await viewingTermsDoc(run, id);
  if (!ownerAccepted) return doc;
  if (await documents.viewingTermsPdfExists(doc.requestId)) {
    return { ...doc, pdfUrl: await documents.viewingTermsPdfUrl(doc.requestId) };
  }
  await mlsJobs.queueViewingTermsPdf.enqueue(
    {
      eventId: newId(),
      agencyId: doc.ownerAgencyId,
      change: {
        agencyId: doc.ownerAgencyId,
        requestId: doc.requestId,
        introducerAgencyId: doc.introducerAgencyId,
        ownerAgencyId: doc.ownerAgencyId,
        action: 'ACCEPTED',
        by: 'OWNER',
        userId: null,
        termsAccepted: true,
      },
    },
    { throttleMs: TERMS_PDF_RETRY_MS, debounceKey: `terms-pdf.${doc.requestId}` },
  );
  return doc;
}
