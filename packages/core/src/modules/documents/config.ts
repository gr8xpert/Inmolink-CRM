/**
 * Documents settings (S12-05). Template changes bump `DOCUMENT_TEMPLATE_VERSION` (part of every document id, so a
 * new layout never serves an old file).
 */
export const DOCUMENT_TEMPLATE_VERSION = 1;

/** Renders of one agency running at once across the `pdf` pool (fair share: one agency's 50 portfolios wait). */
export const DOCUMENT_RENDERS_PER_AGENCY = 2;

/** A document id stays the same for the same request within this window (double clicks, retries share one file). */
export const DOCUMENT_ID_WINDOW_MS = 5 * 60_000;

/** The largest PDF stored (a 50-listing portfolio of web-sized photos is far below it). */
export const DOCUMENT_MAX_BYTES = 60 * 1024 * 1024;

/** Signed download links live this long (`DocumentDto.url`). */
export const DOCUMENT_LINK_SECONDS = 15 * 60;

/** Storage: private bucket, never public. */
export const documentKey = (agencyId: string, documentId: string) => `documents/${agencyId}/${documentId}.pdf`;

/** The accepted terms of a viewing request (S11-02): one file both agencies read; the terms never change. */
export const viewingTermsKey = (requestId: string) => `documents/viewing-terms/${requestId}.pdf`;

interface DocumentsSettings {
  /** Pages one worker process renders at once (`PDF_RENDER_CONCURRENCY`): the per-process cap of render jobs. */
  renderConcurrency: number;
}

let settings: DocumentsSettings = { renderConcurrency: 2 };

/** The pdf pool at boot (and tests). */
export function configureDocuments(next: Partial<DocumentsSettings>): void {
  settings = { ...settings, ...next };
}

export const documentsSettings = (): DocumentsSettings => settings;
