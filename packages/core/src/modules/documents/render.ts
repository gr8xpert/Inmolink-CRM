/**
 * The `pdf` pool's work (S12-05): load what a document shows, build its HTML, render it and store it.
 *
 * Listings are read as the website API reads them (CLAUDE.md rule 9): the public read models (`search.publicDocs`,
 * `app_public` — PUBLIC listings only, prices and status as they are now), presented as on a website of the
 * requesting agency (`websiteApi.viewWith` + `websites.serializeDetail`): another agency's listing carries the
 * requesting agency's presenter, never its owner's name, contacts or commission, and its text has passed the white-label
 * sanitizer (the deterministic pass plus the model pass's cached removals, S12-03); it is re-checked as presentable
 * (`search.networkPresentable`) when the document renders. Idempotent: a document already
 * stored is not rendered again (its id names its content).
 */
import { withPublicRead } from '@inmolink/db';
import { DEFAULT_UI_LOCALE, FALLBACK_CONTENT_LOCALE, isUiLocale } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import { AppError } from '@inmolink/platform/errors';
import { pdf } from '@inmolink/platform/pdf';
import { UnrecoverableError } from '@inmolink/platform/queue';
import { storage } from '@inmolink/platform/storage';
import type { z } from 'zod';
import * as agencies from '../agencies';
import * as search from '../search';
import * as websiteApi from '../website-api';
import * as websites from '../websites';
import { DOCUMENT_LINK_SECONDS, DOCUMENT_MAX_BYTES, documentKey, viewingTermsKey } from './config';
import type { ListingsDocumentPayload, ViewingTermsPayload } from './payloads';
import { brochureHtml, docFormat, portfolioHtml, viewingTermsHtml } from './templates';

const PDF = { contentType: 'application/pdf' } as const;

/** A PDF past `DOCUMENT_MAX_BYTES` is not stored: the render fails for good (a template or asset problem). */
function checkedSize(bytes: Uint8Array): Uint8Array {
  if (bytes.length > DOCUMENT_MAX_BYTES) {
    throw new UnrecoverableError(`pdf: ${bytes.length} bytes over the ${DOCUMENT_MAX_BYTES}-byte limit`);
  }
  return bytes;
}
const uiLocale = (locale: string) => (isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE);

/** The listings of a document as the agency presents them, in the requested order; unavailable ones are left out. */
export async function loadDocumentListings(input: { agencyId: string; listingIds: readonly string[]; locale: string }) {
  return withPublicRead(async (tx) => {
    const agency = (await agencies.publicAgencies(tx, [input.agencyId])).get(input.agencyId) ?? null;
    const presenter = websites.sitePresenter({ name: agency?.name ?? '', contact: null }, agency);
    const docs = await search.publicDocs(tx, input.listingIds, 'detail', input.locale, FALLBACK_CONTENT_LOCALE);
    // S12 review: another agency's listing only while it is still presentable by this agency at render time (shared
    // with it, not hidden from the network, both agencies listed) — unshared since the request: left out (none left:
    // DOCUMENT_LISTINGS_INVALID).
    const others = docs.filter((r) => r.ownerAgencyId !== input.agencyId).map((r) => r.targetId);
    const shared = others.length > 0 ? await search.networkPresentable(tx, input.agencyId, others) : new Set<string>();
    const rows = docs.filter((r) => r.ownerAgencyId === input.agencyId || shared.has(r.targetId));
    const { view } = await websiteApi.viewWith(
      tx,
      { scope: { agencyId: input.agencyId, referencePrefix: null, presenter } },
      input.locale,
      rows,
    );
    const byTarget = new Map(rows.map((r) => [r.targetId, r]));
    const items = input.listingIds.flatMap((id) => {
      const r = byTarget.get(id);
      if (!r) return [];
      return [
        websites.serializeDetail(view, {
          ownerAgencyId: r.ownerAgencyId,
          publicCode: r.publicCode,
          developmentCode: r.developmentCode,
          developmentOwnRef: r.developmentOwnRef,
          doc: r.doc as Parameters<typeof websites.serializeDetail>[1]['doc'],
        }),
      ];
    });
    return { presenter: view.presenter, items };
  });
}

/** The HTML of a brochure or portfolio (the worker renders it; tests and the perf check read it). */
export async function listingsDocumentHtml(p: z.output<typeof ListingsDocumentPayload>, asOf: Date): Promise<string> {
  const { presenter, items } = await loadDocumentListings(p);
  // Nothing left to show (every listing withdrawn since the request): a permanent failure, no retry.
  if (items.length === 0) throw new AppError('DOCUMENT_LISTINGS_INVALID', { documentId: p.documentId }, false);
  const input = { presenter, items, t: translator(uiLocale(p.locale), 'documents'), format: docFormat(p.locale), asOf };
  return p.kind === 'BROCHURE' ? brochureHtml(input) : portfolioHtml({ ...input, title: p.title });
}

export async function renderListingsDocument(
  p: z.output<typeof ListingsDocumentPayload>,
  options: { signal?: AbortSignal; now?: Date } = {},
): Promise<{ rendered: boolean; bytes?: number }> {
  const key = documentKey(p.agencyId, p.documentId);
  if (await storage().head('private', key)) return { rendered: false };
  const html = await listingsDocumentHtml(p, options.now ?? new Date());
  const bytes = checkedSize(await pdf().render(html, { signal: options.signal }));
  await storage().put('private', key, bytes, PDF);
  return { rendered: true, bytes: bytes.length };
}

export async function renderViewingTermsDocument(
  p: z.output<typeof ViewingTermsPayload>,
  options: { signal?: AbortSignal } = {},
): Promise<{ rendered: boolean; bytes?: number }> {
  const key = viewingTermsKey(p.requestId);
  if (await storage().head('private', key)) return { rendered: false };
  const html = viewingTermsHtml({
    requestId: p.requestId,
    target: p.target,
    introducerName: p.introducerName,
    ownerName: p.ownerName,
    commissionBp: p.commissionBp,
    commissionFixed: p.commissionFixed,
    splitBp: p.splitBp,
    includesVat: p.includesVat,
    validUntil: new Date(p.validUntil),
    snapshotAt: new Date(p.snapshotAt),
    introducerAcceptedAt: new Date(p.introducerAcceptedAt),
    ownerAcceptedAt: new Date(p.ownerAcceptedAt),
    scheduledAt: p.scheduledAt ? new Date(p.scheduledAt) : null,
    t: translator(uiLocale(p.locale), 'documents'),
    format: docFormat(p.locale),
  });
  const bytes = checkedSize(await pdf().render(html, { signal: options.signal }));
  await storage().put('private', key, bytes, PDF);
  return { rendered: true, bytes: bytes.length };
}

/** Whether a viewing request's accepted-terms PDF has been rendered (a storage HEAD: never inside a transaction). */
export async function viewingTermsPdfExists(requestId: string): Promise<boolean> {
  return (await storage().head('private', viewingTermsKey(requestId))) !== null;
}

/**
 * A short signed link to a viewing request's accepted-terms PDF (S11-02's `pdfUrl`). Local signing (no network call);
 * the file is rendered within seconds of the owner's acceptance — until then the link answers 404.
 */
export function viewingTermsPdfUrl(requestId: string): Promise<string> {
  return storage().signedGetUrl('private', viewingTermsKey(requestId), {
    expiresInSeconds: DOCUMENT_LINK_SECONDS,
    downloadName: `viewing-terms-${requestId}.pdf`,
    responseContentType: 'application/pdf',
  });
}
