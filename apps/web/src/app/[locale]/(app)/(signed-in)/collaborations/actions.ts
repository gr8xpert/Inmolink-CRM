'use server';

import {
  CreateRegistrationBody,
  CreateViewingRequestBody,
  RescheduleViewingBody,
  ViewingOutcome,
} from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import { getPathname } from '@/i18n/navigation';
import { requireSession } from '@/server/actions';
import { readAgencyTimeZone } from '@/server/agency-time-zone';
import type { ApiResult } from '@/server/api';
import {
  acceptViewing,
  cancelViewing,
  declineViewing,
  recordViewingOutcome,
  registerClient,
  requestViewing,
  rescheduleViewing,
} from '@/server/collaborations-api';
import { parseLocalDateTime } from '../tasks/time';
import { collaborationQuery, parseCollaborationParams } from './filters';
import { type DoneNotice, type Refusal, refusalOf } from './refusals';
import { parseTargetParams } from './register/target';

/**
 * Collaboration actions (S17-F56, transport only): forms post here, the contracts validate, the API decides. Each action
 * returns to where the member was with `done` or the refusal's key (i18n keys under `network.collaborations`).
 */

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

async function toPath(path: string, query: Record<string, string>): Promise<never> {
  redirect(`${getPathname({ href: path, locale: await getLocale() })}?${new URLSearchParams(query).toString()}`);
}

/** Back to the list, with the filters the form was on (only the ones the page knows). */
const toList = (form: FormData, extra: { done: DoneNotice } | { error: Refusal }) =>
  toPath('/collaborations', {
    ...collaborationQuery(parseCollaborationParams(Object.fromEntries(new URLSearchParams(text(form, 'back'))))),
    ...extra,
  });

async function settle(res: ApiResult<unknown>, form: FormData, done: DoneNotice): Promise<never> {
  if (res === 'revoked') redirect('/session/expired');
  return toList(form, res.ok ? { done } : { error: refusalOf(res.error) });
}

/** A typed local time, read in the agency's zone, as the contract's date-time; a refusal's key when it cannot be. */
async function proposedStartAt(form: FormData): Promise<{ at: string } | { error: Refusal }> {
  const value = text(form, 'proposedStartAt');
  if (!value) return { error: 'TIME_REQUIRED' };
  const timeZone = await readAgencyTimeZone(await requireSession());
  if (!timeZone) return { error: 'generic' };
  const at = parseLocalDateTime(value, timeZone);
  return at ? { at: at.toISOString() } : { error: 'TIME_REQUIRED' };
}

export async function registerClientAction(form: FormData): Promise<void> {
  const session = await requireSession();
  const target = parseTargetParams({ kind: text(form, 'kind'), id: text(form, 'id') });
  if (!target) return toList(form, { error: 'REGISTRATION_TARGET_NOT_FOUND' });
  const back = (error: Refusal) => toPath('/collaborations/register', { kind: target.kind, id: target.id, error });
  const parsed = CreateRegistrationBody.safeParse({ contactId: text(form, 'contactId'), target });
  if (!parsed.success) return back('NO_CONTACT');
  const res = await registerClient(session, parsed.data);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) return back(refusalOf(res.error));
  // 201 is a new registration; 200 is the agency's own, still valid: nothing new was written.
  const done: DoneNotice = res.status === 201 ? 'registered' : 'alreadyRegistered';
  return toPath('/collaborations', { direction: 'OUT', type: 'REGISTRATION', done });
}

export async function requestViewingAction(form: FormData): Promise<void> {
  const session = await requireSession();
  const key = text(form, 'idempotencyKey');
  const time = await proposedStartAt(form);
  if ('error' in time) return toList(form, { error: time.error });
  const parsed = CreateViewingRequestBody.safeParse({
    registrationId: text(form, 'registrationId'),
    proposedStartAt: time.at,
  });
  if (!parsed.success || !/^[A-Za-z0-9-]{16,64}$/.test(key)) return toList(form, { error: 'VALIDATION_FAILED' });
  return settle(await requestViewing(session, parsed.data, key), form, 'viewingRequested');
}

/** The viewing's id from the form, or back to the list with a refusal. */
async function viewingId(form: FormData): Promise<string> {
  const id = text(form, 'id');
  if (!z.uuid().safeParse(id).success) return toList(form, { error: 'VIEWING_REQUEST_NOT_FOUND' });
  return id;
}

export async function acceptViewingAction(form: FormData): Promise<void> {
  const id = await viewingId(form);
  return settle(await acceptViewing(await requireSession(), id), form, 'accepted');
}

export async function declineViewingAction(form: FormData): Promise<void> {
  const id = await viewingId(form);
  return settle(await declineViewing(await requireSession(), id), form, 'declined');
}

export async function cancelViewingAction(form: FormData): Promise<void> {
  const id = await viewingId(form);
  return settle(await cancelViewing(await requireSession(), id), form, 'cancelled');
}

export async function rescheduleViewingAction(form: FormData): Promise<void> {
  const id = await viewingId(form);
  const session = await requireSession();
  const time = await proposedStartAt(form);
  if ('error' in time) return toList(form, { error: time.error });
  const parsed = RescheduleViewingBody.safeParse({ proposedStartAt: time.at });
  if (!parsed.success) return toList(form, { error: 'VALIDATION_FAILED' });
  return settle(await rescheduleViewing(session, id, parsed.data), form, 'rescheduled');
}

export async function recordOutcomeAction(form: FormData): Promise<void> {
  const id = await viewingId(form);
  const outcome = ViewingOutcome.safeParse(text(form, 'outcome'));
  if (!outcome.success) return toList(form, { error: 'VALIDATION_FAILED' });
  return settle(await recordViewingOutcome(await requireSession(), id, { outcome: outcome.data }), form, 'outcome');
}
