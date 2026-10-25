'use server';

import {
  CreateNetworkPostBody,
  NETWORK_POST_KINDS,
  NetworkSubscriptionBody,
  ReplyNetworkPostBody,
  TRANSACTION_TYPES,
} from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import { getPathname } from '@/i18n/navigation';
import { cents, requireSession, settle } from '@/server/actions';
import {
  closeBoardPost,
  createBoardPost,
  createSubscription,
  deleteSubscription,
  replyToBoardPost,
} from '@/server/network-api';

/**
 * Network board actions (S12-F1, transport only): forms post here, the contracts validate, the API decides. Each action
 * returns to the board with `done` or the error code (i18n keys under `network.board.errors`), except a reply, which
 * opens the chat thread it started.
 */

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

async function backTo(path: string, extra: Record<string, string>): Promise<never> {
  const query = new URLSearchParams(extra);
  redirect(`${getPathname({ href: path, locale: await getLocale() })}?${query.toString()}`);
}
const board = (extra: Record<string, string>) => backTo('/network/board', extra);

const integer = (v: string): number | undefined | null => {
  if (!v) return undefined;
  return /^\d{1,2}$/.test(v) ? Number(v) : null;
};

export async function createPostAction(form: FormData): Promise<void> {
  const session = await requireSession();
  const key = text(form, 'idempotencyKey');
  const [min, max, beds] = [cents(text(form, 'priceMin')), cents(text(form, 'priceMax')), integer(text(form, 'beds'))];
  const transactionType = text(form, 'transactionType');
  const propertyTypeId = text(form, 'propertyTypeId');
  const expiresRaw = text(form, 'expiresInDays');
  const expires = expiresRaw ? Number(expiresRaw) : undefined;
  if (expires !== undefined && !Number.isFinite(expires)) return board({ error: 'VALIDATION_FAILED' });
  if (min === null || max === null || beds === null || !/^[A-Za-z0-9-]{16,64}$/.test(key)) {
    return board({ error: 'VALIDATION_FAILED' });
  }
  const parsed = CreateNetworkPostBody.safeParse({
    kind: text(form, 'kind'),
    title: text(form, 'title'),
    body: text(form, 'body'),
    criteria: {
      ...(transactionType ? { transactionType } : {}),
      ...(propertyTypeId ? { propertyTypeIds: [propertyTypeId] } : {}),
      ...(min !== undefined ? { priceMinCents: min } : {}),
      ...(max !== undefined ? { priceMaxCents: max } : {}),
      ...(beds !== undefined ? { bedsMin: beds } : {}),
    },
    ...(expires !== undefined ? { expiresInDays: expires } : {}),
  });
  if (!parsed.success) return board({ error: 'VALIDATION_FAILED' });
  return settle(await createBoardPost(session, parsed.data, key), board, 'posted');
}

export async function closePostAction(form: FormData): Promise<void> {
  const id = text(form, 'id');
  if (!z.uuid().safeParse(id).success) return board({ error: 'VALIDATION_FAILED' });
  return settle(await closeBoardPost(await requireSession(), id), board, 'closed');
}

/** A reply opens (or joins) the agency's chat thread with the poster and sends the first message in it. */
export async function replyAction(form: FormData): Promise<void> {
  const id = text(form, 'id');
  const parsed = ReplyNetworkPostBody.safeParse({ body: text(form, 'body'), clientKey: text(form, 'clientKey') });
  if (!z.uuid().safeParse(id).success || !parsed.success) return board({ error: 'VALIDATION_FAILED' });
  const res = await replyToBoardPost(await requireSession(), id, parsed.data);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) return board({ error: res.error?.code ?? 'generic' });
  return backTo(`/chat/${res.data.thread.id}`, {});
}

export async function addSubscriptionAction(form: FormData): Promise<void> {
  const kinds = form.getAll('kinds').filter((k): k is string => NETWORK_POST_KINDS.includes(k as never));
  const transactionType = text(form, 'transactionType');
  const max = cents(text(form, 'priceMax'));
  if (max === null || (transactionType && !TRANSACTION_TYPES.includes(transactionType as never))) {
    return board({ error: 'VALIDATION_FAILED' });
  }
  const parsed = NetworkSubscriptionBody.safeParse({
    name: text(form, 'name'),
    ...(kinds.length > 0 ? { kinds } : {}),
    ...(transactionType ? { transactionType } : {}),
    ...(max !== undefined ? { priceMaxCents: max } : {}),
  });
  if (!parsed.success) return board({ error: 'VALIDATION_FAILED' });
  return settle(await createSubscription(await requireSession(), parsed.data), board, 'subscribed');
}

export async function deleteSubscriptionAction(form: FormData): Promise<void> {
  const id = text(form, 'id');
  if (!z.uuid().safeParse(id).success) return board({ error: 'VALIDATION_FAILED' });
  return settle(await deleteSubscription(await requireSession(), id), board, 'unsubscribed');
}
