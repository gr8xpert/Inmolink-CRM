'use server';

import { ApiKeyParams, CreateApiKeyBody } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { type ApiResult, createApiKey, revokeApiKey, rotateApiKey, sessionRef } from '@/server/api';

/**
 * API key form actions (S1-05, transport only): validate with the contracts, call the API. Create and
 * rotate return the whole key to the form, which shows it this once (it is never put in a URL, a
 * cookie or a log). Error values are i18n keys under `apiKeys.errors`.
 */
export interface IssuedKeyState {
  /** The whole key, shown once. */
  secret?: string;
  name?: string;
  error?: KeyError;
}

export const KEY_ERRORS = [
  'FORBIDDEN',
  'NOT_FOUND',
  'VERIFICATION_REQUIRED',
  'API_KEY_LIMIT_REACHED',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'generic',
] as const;
export type KeyError = (typeof KEY_ERRORS)[number];

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v : undefined;
};

async function session() {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  return sessionRef(s.user);
}

function errorOf(res: Exclude<ApiResult<unknown>, 'revoked'>): KeyError {
  if (res.ok) return 'generic';
  return KEY_ERRORS.find((c) => c === res.error?.code) ?? 'generic';
}

/** Origins: one per line (or comma separated) in a textarea. */
const originsOf = (raw: string | undefined) =>
  (raw ?? '')
    .split(/[\s,]+/)
    .map((o) => o.trim())
    .filter(Boolean);

export async function createKeyAction(_prev: IssuedKeyState, form: FormData): Promise<IssuedKeyState> {
  const kind = text(form, 'kind');
  const parsed = CreateApiKeyBody.safeParse({
    name: text(form, 'name'),
    kind,
    scopes: form.getAll('scopes').filter((s): s is string => typeof s === 'string'),
    allowedOrigins: kind === 'PUBLISHABLE' ? originsOf(text(form, 'allowedOrigins')) : [],
  });
  if (!parsed.success) return { error: 'VALIDATION_FAILED' };
  const res = await createApiKey(await session(), parsed.data);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) return { error: errorOf(res) };
  return { secret: res.data.secret, name: res.data.key.name };
}

export async function rotateKeyAction(_prev: IssuedKeyState, form: FormData): Promise<IssuedKeyState> {
  const params = ApiKeyParams.safeParse({ keyId: text(form, 'keyId') });
  if (!params.success) return { error: 'VALIDATION_FAILED' };
  const res = await rotateApiKey(await session(), params.data.keyId);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) return { error: errorOf(res) };
  return { secret: res.data.secret, name: res.data.key.name };
}

/** Plain form: back to the list with a notice or an error. */
export async function revokeKeyAction(form: FormData): Promise<void> {
  const params = ApiKeyParams.safeParse({ keyId: text(form, 'keyId') });
  const path = getPathname({ href: '/api-keys', locale: await getLocale() });
  if (!params.success) redirect(`${path}?error=VALIDATION_FAILED`);
  const res = await revokeApiKey(await session(), params.data.keyId);
  if (res === 'revoked') redirect('/session/expired');
  redirect(res.ok ? `${path}?notice=revoked` : `${path}?error=${errorOf(res)}`);
}
