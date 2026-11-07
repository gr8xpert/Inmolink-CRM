'use server';

import { DEAL_STAGES, type MediateDealBody } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { getPathname } from '@/i18n/navigation';
import { requireSession } from '@/server/actions';
import type { ApiResult } from '@/server/api';
import { mediateDeal, resolveDealDispute } from '@/server/deals-api';
import { isUuid, parsePrice, reasonOf } from '../../(signed-in)/deals/query';

/**
 * Staff deal mediation (R2-04c, transport only): the API decides who is staff and which roles mediate or resolve
 * (data ops, super admins). Back to the deal's mediation page with a notice or the API's error code.
 */
const KNOWN_ERRORS = [
  'FORBIDDEN',
  'DEAL_NOT_FOUND',
  'DEAL_STATE',
  'DEAL_DISPUTE_NOT_FOUND',
  'DEAL_DISPUTE_STATE',
  'VALIDATION_FAILED',
] as const;

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

async function back(id: string, query: Record<string, string>): Promise<never> {
  const path = getPathname({ href: `/staff/deals/${id}`, locale: await getLocale() });
  redirect(`${path}?${new URLSearchParams(query)}`);
}

async function settle(id: string, res: ApiResult<unknown>, notice: string): Promise<never> {
  if (res === 'revoked') redirect('/session/expired');
  if (res.ok) return back(id, { notice });
  const code = KNOWN_ERRORS.find((c) => c === res.error?.code) ?? 'generic';
  const reason = (res.error?.details as { reason?: unknown } | undefined)?.reason;
  return back(id, {
    error: code,
    ...(code === 'DEAL_STATE' && typeof reason === 'string' && /^[a-z_]{1,40}$/.test(reason) ? { reason } : {}),
  });
}

/** Set the stage and / or the price of a deal with a reason both parties see (audited). Empty fields stay as they are. */
export async function mediateDealAction(form: FormData): Promise<void> {
  const id = text(form, 'dealId');
  if (!isUuid(id)) redirect('/');
  const reason = reasonOf(form);
  const stage = DEAL_STAGES.find((s) => s === text(form, 'stage'));
  const amount = text(form, 'amount');
  const price = amount ? parsePrice(amount, text(form, 'currency')) : undefined;
  if (!reason || price === null || (!stage && !price)) return back(id, { error: 'VALIDATION_FAILED' });
  const body: MediateDealBody = { reason, ...(stage ? { stage } : {}), ...(price ? { price } : {}) };
  return settle(id, await mediateDeal(await requireSession(), id, body), 'mediated');
}

/** Close an open dispute with a note the raising agency reads (audited). */
export async function resolveDealDisputeAction(form: FormData): Promise<void> {
  const id = text(form, 'dealId');
  const disputeId = text(form, 'disputeId');
  if (!isUuid(id)) redirect('/');
  const note = reasonOf(form, 'note');
  if (!isUuid(disputeId) || !note) return back(id, { error: 'VALIDATION_FAILED' });
  return settle(id, await resolveDealDispute(await requireSession(), disputeId, note), 'resolved');
}
