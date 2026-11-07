'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { getPathname } from '@/i18n/navigation';
import { requireSession } from '@/server/actions';
import { readAgencyTimeZone } from '@/server/agency-time-zone';
import type { ApiResult } from '@/server/api';
import {
  advanceDeal,
  confirmDeal,
  createDealTask,
  fallThroughDeal,
  openDeal,
  openDealDispute,
  openDealDocument,
  openDealThread,
  removeDealDocument,
  setDealPrice,
  withdrawDealConfirmation,
} from '@/server/deals-api';
import { refusalOf } from '../collaborations/refusals';
import { parseLocalDateTime } from '../tasks/time';
import { type DealNotice, isUuid, priceOf, reasonOf, seenPriceOf } from './query';

/**
 * The deal room's moves (R2-04c, transport only): forms post here, the parsers keep malformed input out, the API
 * decides. Each move returns to the deal with `done` or the API's error code (and `reason`, for `DEAL_STATE`), i18n keys
 * under `network.deals`.
 */

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

async function toDeal(id: string, query: Record<string, string>): Promise<never> {
  const path = getPathname({ href: `/deals/${id}`, locale: await getLocale() });
  redirect(`${path}?${new URLSearchParams(query).toString()}`);
}

function refusal(res: Exclude<ApiResult<unknown>, 'revoked'>): Record<string, string> {
  if (res.ok) return {};
  const code = res.error?.code ?? 'generic';
  const reason = (res.error?.details as { reason?: unknown } | undefined)?.reason;
  return typeof reason === 'string' && /^[a-z_]{1,40}$/.test(reason) ? { error: code, reason } : { error: code };
}

async function settle(id: string, res: ApiResult<unknown>, done: DealNotice): Promise<never> {
  if (res === 'revoked') redirect('/session/expired');
  return toDeal(id, res.ok ? { done } : refusal(res));
}

/** The deal a form names, or back home: a tampered form has nowhere sensible to return to. */
function dealIdOf(form: FormData): string {
  const id = text(form, 'dealId');
  if (!isUuid(id)) redirect('/');
  return id;
}

/** From an accepted viewing: open its deal at the offered price (the live one answers a repeat), then into the room. */
export async function openDealAction(form: FormData): Promise<void> {
  const viewingRequestId = text(form, 'viewingRequestId');
  const back = getPathname({ href: '/collaborations', locale: await getLocale() });
  const toList = (error: string): never => redirect(`${back}?${new URLSearchParams({ error })}`);
  const price = priceOf(form);
  if (!isUuid(viewingRequestId) || !price) return toList('VALIDATION_FAILED');
  const res = await openDeal(await requireSession(), { viewingRequestId, price });
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) return toList(refusalOf(res.error));
  return toDeal(res.data.id, { done: 'opened' });
}

export async function advanceDealAction(form: FormData): Promise<void> {
  const id = dealIdOf(form);
  const stage = text(form, 'stage');
  if (stage !== 'RESERVATION' && stage !== 'ARRAS') return toDeal(id, { error: 'VALIDATION_FAILED' });
  return settle(id, await advanceDeal(await requireSession(), id, { stage }), 'advanced');
}

export async function setDealPriceAction(form: FormData): Promise<void> {
  const id = dealIdOf(form);
  const price = priceOf(form);
  if (!price) return toDeal(id, { error: 'VALIDATION_FAILED' });
  return settle(id, await setDealPrice(await requireSession(), id, price), 'priced');
}

/** The handshake: confirms the completion at the price the member saw (a changed one is refused: `price_changed`). */
export async function confirmDealAction(form: FormData): Promise<void> {
  const id = dealIdOf(form);
  const price = seenPriceOf(form);
  if (!price) return toDeal(id, { error: 'VALIDATION_FAILED' });
  return settle(id, await confirmDeal(await requireSession(), id, price), 'confirmed');
}

export async function withdrawDealAction(form: FormData): Promise<void> {
  const id = dealIdOf(form);
  return settle(id, await withdrawDealConfirmation(await requireSession(), id), 'withdrawn');
}

export async function fallThroughDealAction(form: FormData): Promise<void> {
  const id = dealIdOf(form);
  const reason = reasonOf(form);
  if (!reason) return toDeal(id, { error: 'VALIDATION_FAILED' });
  return settle(id, await fallThroughDeal(await requireSession(), id, reason), 'fellThrough');
}

export async function disputeDealAction(form: FormData): Promise<void> {
  const id = dealIdOf(form);
  const reason = reasonOf(form);
  if (!reason) return toDeal(id, { error: 'VALIDATION_FAILED' });
  return settle(id, await openDealDispute(await requireSession(), id, reason), 'disputed');
}

export async function removeDealDocumentAction(form: FormData): Promise<void> {
  const id = dealIdOf(form);
  const documentId = text(form, 'documentId');
  if (!isUuid(documentId)) return toDeal(id, { error: 'VALIDATION_FAILED' });
  return settle(id, await removeDealDocument(await requireSession(), id, documentId), 'removed');
}

/** A short signed link to the document (returned, not redirected to: see `OpenFileForm`); a refusal goes back. */
export async function openDealDocumentAction(form: FormData): Promise<{ url: string }> {
  const id = dealIdOf(form);
  const documentId = text(form, 'documentId');
  if (!isUuid(documentId)) return toDeal(id, { error: 'VALIDATION_FAILED' });
  const res = await openDealDocument(await requireSession(), id, documentId);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) return toDeal(id, refusal(res));
  return { url: res.data.url };
}

export async function addDealTaskAction(form: FormData): Promise<void> {
  const id = dealIdOf(form);
  const session = await requireSession();
  const title = text(form, 'title');
  const due = text(form, 'dueAt');
  const key = text(form, 'idempotencyKey');
  if (title.length < 1 || title.length > 200 || !/^[A-Za-z0-9-]{16,64}$/.test(key)) {
    return toDeal(id, { error: 'VALIDATION_FAILED' });
  }
  let dueAt: string | undefined;
  if (due) {
    const timeZone = await readAgencyTimeZone(session);
    const at = timeZone ? parseLocalDateTime(due, timeZone) : null;
    if (!at) return toDeal(id, { error: 'VALIDATION_FAILED' });
    dueAt = at.toISOString();
  }
  const body = { title, remind: form.get('remind') === 'on', ...(dueAt ? { dueAt } : {}) };
  return settle(id, await createDealTask(session, id, body, key), 'taskAdded');
}

/** Into the deal's chat thread with the other party (opened, or joined, on the way). */
export async function openDealChatAction(form: FormData): Promise<void> {
  const id = dealIdOf(form);
  const res = await openDealThread(await requireSession(), id);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) return toDeal(id, refusal(res));
  redirect(getPathname({ href: `/chat/${res.data.id}`, locale: await getLocale() }));
}
