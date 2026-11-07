/**
 * Window cards (R2-06, PLAN §7 M13): printable cards with the agency's branding and a QR code to each listing's live,
 * branded page — a selection of that one listing (`/s/<token>`, white-labelled, prices and status as they are now).
 *
 * A batch (≤ `WINDOW_CARDS_MAX` listings, one template, PDF or HTML) is ONE `pdf`-pool job and ONE file, a page per
 * card. No table: the request's id is the hash of what it shows (template version, agency, locale, template, format,
 * listings in order, a 5-minute window), its state is its job's, the file lives in the private bucket like every
 * document. Two steps (CLAUDE.md rule 6): `prepareWindowCards` checks in the request's transaction, `startWindowCards`
 * queues after it committed.
 *
 * The job (idempotent: a stored file is not rendered again): reads the listings as the agency presents them
 * (`documents.loadDocumentListings`: public read models, white-labelled, text sanitized), makes or finds each card's
 * page (derived token, `repo.upsertWindowCardSelections`: three statements for the whole batch, never one per card),
 * draws the QR codes in memory, builds the HTML, renders once and stores. Memory is the batch's HTML and QR strings
 * plus one PDF; the browser's pages are the pool's (`PDF_RENDER_CONCURRENCY`).
 */
import { createHash } from 'node:crypto';
import { SELECTION_LIMITS, WINDOW_CARDS_MAX, WindowCardFormat, WindowCardTemplateId } from '@inmolink/contracts';
import { withSystem } from '@inmolink/db';
import { DEFAULT_UI_LOCALE, isUiLocale } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { pdf } from '@inmolink/platform/pdf';
import { UnrecoverableError } from '@inmolink/platform/queue';
import { storage } from '@inmolink/platform/storage';
import QRCode from 'qrcode';
import { z } from 'zod';
import * as documents from '../documents';
import { publicBaseUrl, selectionPath, selectionTokenHash, windowCardToken } from './config';
import * as repo from './repo';
import { windowCardsHtml, windowCardTemplate } from './window-cards-templates';

/** A change of a card's layout bumps this (part of every id, so a new layout never serves an old file). */
export const WINDOW_CARDS_TEMPLATE_VERSION = 1;

/** A request for the same cards is the same document within this window (double clicks and retries share one job). */
export const WINDOW_CARDS_ID_WINDOW_MS = 5 * 60_000;
export const WINDOW_CARDS_LINK_SECONDS = 15 * 60;
export const WINDOW_CARDS_JOB = 'presentations.renderWindowCards';
export const WINDOW_CARDS_CONTENT_TYPE = { PDF: 'application/pdf', HTML: 'text/html; charset=utf-8' } as const;
export const WINDOW_CARDS_EXTENSION = { PDF: 'pdf', HTML: 'html' } as const;

export const WindowCardsPayload = z.object({
  documentId: z.string().regex(/^[0-9a-f]{32}$/),
  agencyId: z.uuid(),
  /** The member who asked (the cards' pages are made in their name). */
  createdBy: z.uuid(),
  template: WindowCardTemplateId,
  format: WindowCardFormat,
  locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
  listingIds: z.array(z.uuid()).min(1).max(WINDOW_CARDS_MAX),
});
export type WindowCardsPayload = z.infer<typeof WindowCardsPayload>;

export const windowCardsKey = (agencyId: string, documentId: string, format: WindowCardFormat) =>
  `documents/${agencyId}/window-cards-${documentId}.${WINDOW_CARDS_EXTENSION[format]}`;

export function windowCardsIdOf(input: Omit<WindowCardsPayload, 'documentId' | 'createdBy'> & { window: number }) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        WINDOW_CARDS_TEMPLATE_VERSION,
        input.agencyId,
        input.locale,
        input.template,
        input.format,
        input.listingIds,
        input.window,
      ]),
    )
    .digest('hex')
    .slice(0, 32);
}

const uiLocale = (locale: string) => (isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE);

/** Cards' HTML for a batch (the worker renders it; tests read it). */
export async function windowCardsBatchHtml(
  p: WindowCardsPayload,
): Promise<{ html: string; cards: number; urls: Map<string, string> }> {
  const base = publicBaseUrl();
  if (!base) throw new UnrecoverableError('window cards: PUBLIC_PAGES_URL is not configured');
  const { presenter, entries } = await documents.loadDocumentListings({
    agencyId: p.agencyId,
    listingIds: p.listingIds,
    locale: p.locale,
  });
  // Nothing left to show (every listing withdrawn since the request): permanent, no retry.
  if (entries.length === 0) throw new AppError('DOCUMENT_LISTINGS_INVALID', { documentId: p.documentId }, false);

  // One card page per listing, found or made in three statements (not per card).
  const pages = entries.map(({ id, detail: d }) => {
    const token = windowCardToken(p.agencyId, id);
    return {
      id,
      d,
      token,
      hash: selectionTokenHash(token),
      url: `${base}${selectionPath(token)}`,
    };
  });
  await withSystem('presentations.windowCards.pages', (tx) =>
    repo.upsertWindowCardSelections(
      tx,
      pages.map((x) => ({
        selection: {
          id: newId(),
          agencyId: p.agencyId,
          createdBy: p.createdBy,
          contactId: null,
          title: x.d.title.trim().slice(0, SELECTION_LIMITS.titleChars) || x.d.ref,
          message: null,
          locale: p.locale,
          tokenHash: x.hash,
          tokenHint: x.token.slice(-4),
          expiresAt: null,
        },
        item: {
          id: newId(),
          agencyId: p.agencyId,
          targetId: x.id,
          position: 0,
          titleOverride: null,
          note: null,
        },
      })),
    ),
  );

  const cards = await Promise.all(
    pages.map(async (x) => ({
      detail: x.d,
      qrSvg: await QRCode.toString(x.url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
    })),
  );
  const html = windowCardsHtml({
    template: windowCardTemplate(p.template),
    presenter,
    cards,
    t: translator(uiLocale(p.locale), 'documents'),
    format: documents.docFormat(p.locale),
  });
  return { html, cards: cards.length, urls: new Map(pages.map((x) => [x.id, x.url])) };
}

/**
 * The job's work. Idempotent: a stored file is kept. A PDF past `DOCUMENT_MAX_BYTES` is not stored (a permanent
 * failure: photos are the `medium`/`large` presets, so it means a template or asset problem).
 */
export async function renderWindowCards(
  p: WindowCardsPayload,
  options: { signal?: AbortSignal } = {},
): Promise<{ rendered: boolean; cards?: number; bytes?: number }> {
  const key = windowCardsKey(p.agencyId, p.documentId, p.format);
  if (await storage().head('private', key)) return { rendered: false };
  const { html, cards } = await windowCardsBatchHtml(p);
  const bytes = p.format === 'PDF' ? await pdf().render(html, { signal: options.signal }) : Buffer.from(html, 'utf8');
  if (bytes.length > documents.DOCUMENT_MAX_BYTES) {
    throw new UnrecoverableError(
      `window cards: ${bytes.length} bytes over the ${documents.DOCUMENT_MAX_BYTES}-byte limit`,
    );
  }
  await storage().put('private', key, bytes, { contentType: WINDOW_CARDS_CONTENT_TYPE[p.format] });
  return { rendered: true, cards, bytes: bytes.length };
}
