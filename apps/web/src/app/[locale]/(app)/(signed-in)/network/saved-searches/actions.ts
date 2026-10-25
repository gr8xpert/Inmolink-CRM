'use server';

import {
  SAVED_SEARCH_ALERT_KINDS,
  SAVED_SEARCH_FREQUENCIES,
  SAVED_SEARCH_SCOPES,
  SavedSearchBody,
  TRANSACTION_TYPES,
} from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import type { ApiResult, SessionRef } from '@/server/api';
import { sessionRef } from '@/server/api';
import { createSavedSearch, deleteSavedSearch } from '@/server/matching-api';

/**
 * Saved search actions (S5-06, transport only): forms post here, the contracts validate, the API decides. Each action
 * returns to the saved searches with `done` or the error code (i18n keys under `network.savedSearches.errors`).
 */

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

async function back(extra: Record<string, string>): Promise<never> {
  const query = new URLSearchParams(extra);
  redirect(`${getPathname({ href: '/network/saved-searches', locale: await getLocale() })}?${query.toString()}`);
}

async function requireSession(): Promise<SessionRef> {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  return sessionRef(s.user);
}

async function settle(res: ApiResult<unknown>, done: string): Promise<never> {
  if (res === 'revoked') redirect('/session/expired');
  return back(res.ok ? { done } : { error: res.error?.code ?? 'generic' });
}

/** Whole euros to cents; undefined when empty, null when invalid. */
function cents(v: string): number | undefined | null {
  if (!v) return undefined;
  if (!/^\d{1,12}$/.test(v)) return null;
  return Number(v) * 100;
}

const integer = (v: string): number | undefined | null => {
  if (!v) return undefined;
  return /^\d{1,2}$/.test(v) ? Number(v) : null;
};

const UUID = z.uuid();
const optionalId = (v: string): string | undefined | null => {
  if (!v) return undefined;
  return UUID.safeParse(v).success ? v : null;
};

export async function createSavedSearchAction(form: FormData): Promise<void> {
  const session = await requireSession();
  const [min, max, beds] = [cents(text(form, 'priceMin')), cents(text(form, 'priceMax')), integer(text(form, 'beds'))];
  const [type, location] = [optionalId(text(form, 'propertyTypeId')), optionalId(text(form, 'locationId'))];
  const transactionType = text(form, 'transactionType');
  const alerts = form.getAll('alerts').filter((k): k is string => SAVED_SEARCH_ALERT_KINDS.includes(k as never));
  if (
    min === null ||
    max === null ||
    beds === null ||
    type === null ||
    location === null ||
    (transactionType && !TRANSACTION_TYPES.includes(transactionType as never)) ||
    !SAVED_SEARCH_SCOPES.includes(text(form, 'scope') as never) ||
    !SAVED_SEARCH_FREQUENCIES.includes(text(form, 'frequency') as never) ||
    alerts.length === 0
  ) {
    return back({ error: 'VALIDATION_FAILED' });
  }
  const parsed = SavedSearchBody.safeParse({
    name: text(form, 'name'),
    scope: text(form, 'scope'),
    frequency: text(form, 'frequency'),
    alerts,
    ...(transactionType ? { transactionType } : {}),
    ...(type ? { propertyTypeIds: [type] } : {}),
    ...(location ? { locationIds: [location] } : {}),
    ...(min !== undefined ? { priceMinCents: min } : {}),
    ...(max !== undefined ? { priceMaxCents: max } : {}),
    ...(beds !== undefined ? { bedsMin: beds } : {}),
  });
  if (!parsed.success) return back({ error: 'VALIDATION_FAILED' });
  return settle(await createSavedSearch(session, parsed.data), 'saved');
}

export async function deleteSavedSearchAction(form: FormData): Promise<void> {
  const id = text(form, 'id');
  if (!UUID.safeParse(id).success) return back({ error: 'VALIDATION_FAILED' });
  return settle(await deleteSavedSearch(await requireSession(), id), 'deleted');
}
