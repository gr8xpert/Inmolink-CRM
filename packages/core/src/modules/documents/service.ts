/**
 * PDF documents — the dashboard side (S12-05, PLAN §7 M13). An agent asks for a brochure (one listing) or a portfolio
 * (several, in order) in the client's language; the `pdf` pool renders it (`jobs.ts`) and `getDocument` answers its
 * state and, once ready, a short signed link to the file in the private bucket.
 *
 * No table: a document's id is the hash of what it shows (kind, agency, locale, title, listings, template version and
 * a 5-minute window), so the same request in the window is the same document (double clicks and retries share one
 * render) and its state is its render job's (BullMQ keeps finished jobs 24 h, failed ones 7 days; then ask again).
 *
 * Two steps (CLAUDE.md rule 6): `prepare*` runs in the request's transaction (authorization, and the listings checked
 * against what the agency may see — RLS); `startDocument` runs after it committed and queues the render. Nothing is
 * written in the transaction, so there is nothing an enqueue failure could leave half done: the request fails and is
 * asked again (same document id). A failed render is queued afresh when asked again. The render reads the public
 * read models white-labelled for the agency (`render.ts`). Selections (S12-04) render with `preparePortfolio`.
 */
import { createHash } from 'node:crypto';
import type { CreateBrochureBody, CreatePortfolioBody, PdfDocumentDto, PdfDocumentKind } from '@inmolink/contracts';
import { DEFAULT_CONTENT_LOCALE } from '@inmolink/i18n';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { type JobDef, queueFor, stableJobId } from '@inmolink/platform/queue';
import { storage } from '@inmolink/platform/storage';
import type { Ctx, CtxRunner } from '../../context';
import * as search from '../search';
import { DOCUMENT_ID_WINDOW_MS, DOCUMENT_LINK_SECONDS, DOCUMENT_TEMPLATE_VERSION, documentKey } from './config';
import { documentsJobs } from './jobs';
import type { ListingsDocumentPayload, ViewingTermsPayload } from './payloads';
import { assertCan } from './policy';

/** The id of a document: what it shows, in the request's window. */
export function documentIdOf(input: {
  kind: PdfDocumentKind;
  agencyId: string;
  locale: string;
  title: string | null;
  listingIds: readonly string[];
  window: number;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        DOCUMENT_TEMPLATE_VERSION,
        input.kind,
        input.agencyId,
        input.locale,
        input.title,
        input.listingIds,
        input.window,
      ]),
    )
    .digest('hex')
    .slice(0, 32);
}

/** A document checked and ready to queue (`startDocument`, after the transaction). */
export interface PreparedDocument {
  payload: ListingsDocumentPayload;
}

const localeOf = (ctx: Ctx, locale: string | undefined) => locale ?? ctx.tenant.locales[0] ?? DEFAULT_CONTENT_LOCALE;

async function prepare(
  ctx: Ctx,
  input: { kind: PdfDocumentKind; listingIds: readonly string[]; locale?: string; title?: string },
): Promise<PreparedDocument> {
  assertCan(ctx, 'documents.create');
  const locale = localeOf(ctx, input.locale);
  // What the agency may show: its own listings and network listings its RLS reveals (one statement).
  const visible = await search.listingLabels(ctx.tx, input.listingIds, locale);
  const listingIds = input.listingIds.filter((id) => visible.has(id));
  if (listingIds.length === 0 || (input.kind === 'BROCHURE' && listingIds.length !== 1)) {
    throw new AppError('DOCUMENT_LISTINGS_INVALID', { requested: input.listingIds.length });
  }
  return {
    payload: {
      documentId: documentIdOf({
        kind: input.kind,
        agencyId: ctx.tenant.agencyId,
        locale,
        title: input.title ?? null,
        listingIds,
        window: Math.floor(clock.nowMs() / DOCUMENT_ID_WINDOW_MS),
      }),
      agencyId: ctx.tenant.agencyId,
      kind: input.kind,
      locale,
      listingIds,
      title: input.title ?? null,
    },
  };
}

/** One listing's brochure, checked (in the request's transaction). */
export function prepareBrochure(ctx: Ctx, body: CreateBrochureBody): Promise<PreparedDocument> {
  return prepare(ctx, { kind: 'BROCHURE', listingIds: [body.listingId], locale: body.locale });
}

/** Several listings' portfolio, checked (in the request's transaction). */
export function preparePortfolio(ctx: Ctx, body: CreatePortfolioBody): Promise<PreparedDocument> {
  return prepare(ctx, { kind: 'PORTFOLIO', listingIds: body.listingIds, locale: body.locale, title: body.title });
}

/**
 * Queues a job under its stable id; a job of that id that failed for good is removed first, so asking again renders
 * again (instead of answering "failed" until BullMQ drops it after 7 days).
 */
export async function enqueueAfresh<D extends JobDef>(def: D, payload: Parameters<D['enqueue']>[0], id: string) {
  const existing = await queueFor(def.pool).getJob(stableJobId(def.name, id));
  if (existing && (await existing.getState()) === 'failed') await existing.remove();
  await def.enqueue(payload);
}

/** Queues the render (after the transaction committed) and answers the document's state. */
export async function startDocument(prepared: PreparedDocument): Promise<PdfDocumentDto> {
  const { payload } = prepared;
  await enqueueAfresh(documentsJobs.renderListings, payload, payload.documentId);
  return documentState(payload.agencyId, payload.documentId);
}

/** `POST /v1/documents/brochures`: one listing's brochure in the client's language. */
export async function requestBrochure(run: CtxRunner, body: CreateBrochureBody): Promise<PdfDocumentDto> {
  return startDocument(await run((ctx) => prepareBrochure(ctx, body)));
}

/** `POST /v1/documents/portfolios`: several listings (a cover, then a page each), in the given order. */
export async function requestPortfolio(run: CtxRunner, body: CreatePortfolioBody): Promise<PdfDocumentDto> {
  return startDocument(await run((ctx) => preparePortfolio(ctx, body)));
}

/** `GET /v1/documents/:documentId`: the document's state, with a fresh signed link once it is ready. */
export async function getDocument(run: CtxRunner, documentId: string): Promise<PdfDocumentDto> {
  const agencyId = await run(async (ctx) => {
    assertCan(ctx, 'documents.read');
    return ctx.tenant.agencyId;
  });
  return documentState(agencyId, documentId);
}

/** The render job's state, as seen by `agencyId` only (another agency's document is not found). */
async function documentState(agencyId: string, documentId: string): Promise<PdfDocumentDto> {
  const job = await queueFor(documentsJobs.renderListings.pool).getJob(
    stableJobId(documentsJobs.renderListings.name, documentId),
  );
  const owner = (job?.data as { p?: { agencyId?: unknown } } | undefined)?.p?.agencyId;
  if (!job || owner !== agencyId) throw new AppError('DOCUMENT_NOT_FOUND');
  const state = await job.getState();
  if (state === 'completed') {
    const expiresAt = new Date(clock.nowMs() + DOCUMENT_LINK_SECONDS * 1_000);
    const url = await storage().signedGetUrl('private', documentKey(agencyId, documentId), {
      expiresInSeconds: DOCUMENT_LINK_SECONDS,
      downloadName: `${documentId}.pdf`,
      responseContentType: 'application/pdf',
    });
    return { id: documentId, status: 'READY', url, urlExpiresAt: expiresAt.toISOString() };
  }
  return { id: documentId, status: state === 'failed' ? 'FAILED' : 'PENDING', url: null, urlExpiresAt: null };
}

/**
 * S11-02: queues the accepted-terms PDF of a viewing request (one per request: the terms never change); a failed
 * render is queued afresh.
 */
export async function queueViewingTermsPdf(payload: ViewingTermsPayload): Promise<void> {
  await enqueueAfresh(documentsJobs.renderViewingTerms, payload, payload.requestId);
}
