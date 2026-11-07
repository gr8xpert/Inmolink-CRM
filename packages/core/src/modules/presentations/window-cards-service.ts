/**
 * Window cards, the request side (R2-06): `POST /v1/window-cards` checks in the request's transaction
 * (`prepareWindowCards`) and queues after it committed (`startWindowCards`); `GET` answers the job's state with a short
 * signed link once the file is stored. See `window-cards.ts` for the job's work.
 */
import {
  type CreateWindowCardsBody,
  type PdfDocumentDto,
  type WindowCardFormat,
  WindowCardTemplateId,
} from '@inmolink/contracts';
import { DEFAULT_CONTENT_LOCALE } from '@inmolink/i18n';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { queueFor, stableJobId } from '@inmolink/platform/queue';
import { storage } from '@inmolink/platform/storage';
import type { Ctx, CtxRunner } from '../../context';
import * as billing from '../billing';
import * as documents from '../documents';
import * as search from '../search';
import { presentationsJobs } from './jobs';
import { assertCan } from './policy';
import {
  WINDOW_CARDS_CONTENT_TYPE as CONTENT_TYPE,
  WINDOW_CARDS_EXTENSION as EXTENSION,
  WINDOW_CARDS_ID_WINDOW_MS as ID_WINDOW_MS,
  WINDOW_CARDS_JOB as JOB_NAME,
  WINDOW_CARDS_LINK_SECONDS as LINK_SECONDS,
  type WindowCardsPayload,
  windowCardsIdOf,
  windowCardsKey,
} from './window-cards';

/** Checked in the request's transaction: allowed, on a plan with PDFs, and only listings the agency may show publicly. */
export async function prepareWindowCards(ctx: Ctx, body: CreateWindowCardsBody): Promise<WindowCardsPayload> {
  assertCan(ctx, 'presentations.write');
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  await billing.requirePlan(ctx, 'pdfs_and_forms');
  const locale = body.locale ?? ctx.tenant.locales[0] ?? DEFAULT_CONTENT_LOCALE;
  const parsed = WindowCardTemplateId.safeParse(body.template);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', { field: 'template' });
  const template = parsed.data;
  const format = body.format ?? 'PDF';
  // What the agency may show (its own and network listings its RLS reveals), and only public ones: one statement.
  const visible = await search.listingLabels(ctx.tx, body.listingIds, locale, { publicOnly: true });
  const listingIds = body.listingIds.filter((id) => visible.has(id));
  if (listingIds.length === 0) throw new AppError('DOCUMENT_LISTINGS_INVALID', { requested: body.listingIds.length });
  const agencyId = ctx.tenant.agencyId;
  return {
    documentId: windowCardsIdOf({
      agencyId,
      locale,
      template,
      format,
      listingIds,
      window: Math.floor(clock.nowMs() / ID_WINDOW_MS),
    }),
    agencyId,
    createdBy: ctx.actor.userId,
    template,
    format,
    locale,
    listingIds,
  };
}

/** Queues the render (after the transaction committed) and answers the document's state. */
export async function startWindowCards(payload: WindowCardsPayload): Promise<PdfDocumentDto> {
  await documents.enqueueAfresh(presentationsJobs.renderWindowCards, payload, payload.documentId);
  return windowCardsState(payload.agencyId, payload.documentId, payload.format);
}

/** `POST /v1/window-cards`. */
export async function requestWindowCards(run: CtxRunner, body: CreateWindowCardsBody): Promise<PdfDocumentDto> {
  return startWindowCards(await run((ctx) => prepareWindowCards(ctx, body)));
}

/** `GET /v1/window-cards/:documentId`: the job's state, as seen by its own agency only. */
export async function getWindowCards(run: CtxRunner, documentId: string): Promise<PdfDocumentDto> {
  const agencyId = await run(async (ctx) => {
    assertCan(ctx, 'presentations.read');
    return ctx.tenant.agencyId;
  });
  return windowCardsState(agencyId, documentId);
}

async function windowCardsState(
  agencyId: string,
  documentId: string,
  knownFormat?: WindowCardFormat,
): Promise<PdfDocumentDto> {
  const job = await queueFor('pdf').getJob(stableJobId(JOB_NAME, documentId));
  const data = (job?.data as { p?: { agencyId?: unknown; format?: unknown } } | undefined)?.p;
  if (!job || data?.agencyId !== agencyId) throw new AppError('DOCUMENT_NOT_FOUND');
  const format = knownFormat ?? (data.format === 'HTML' ? 'HTML' : 'PDF');
  const state = await job.getState();
  if (state === 'completed') {
    const url = await storage().signedGetUrl('private', windowCardsKey(agencyId, documentId, format), {
      expiresInSeconds: LINK_SECONDS,
      downloadName: `window-cards-${documentId}.${EXTENSION[format]}`,
      responseContentType: CONTENT_TYPE[format],
    });
    return {
      id: documentId,
      status: 'READY',
      url,
      urlExpiresAt: new Date(clock.nowMs() + LINK_SECONDS * 1_000).toISOString(),
    };
  }
  return { id: documentId, status: state === 'failed' ? 'FAILED' : 'PENDING', url: null, urlExpiresAt: null };
}
