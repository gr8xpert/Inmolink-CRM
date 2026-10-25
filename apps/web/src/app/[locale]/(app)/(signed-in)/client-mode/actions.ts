'use server';

import { ClientModePin, StartClientModeDto } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth, updateSession } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { apiRequest, sessionRef } from '@/server/api';
import type { ClientModeFormState } from './state';

/**
 * Client Mode forms (S12-06, transport only). Entering: the API checks the PIN against the agency's policy and
 * returns identity's signed hand-over, which the session callback stores (the PIN's hash, in the encrypted cookie).
 * Leaving: the PIN goes to the session callback, where identity checks it — rate-limited and audited; too many wrong
 * PINs end the session (sign in again).
 */

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};

const to = async (href: string): Promise<never> => redirect(getPathname({ href, locale: await getLocale() }));

export async function enterClientModeAction(_prev: ClientModeFormState, form: FormData): Promise<ClientModeFormState> {
  const session = await auth();
  if (!session?.user?.id) return to('/login');
  if (session.user.clientMode) return to('/');
  const pin = text(form, 'pin');
  if (!ClientModePin.safeParse(pin).success) return { error: 'pin_invalid' };
  if (pin !== text(form, 'confirm')) return { error: 'pin_mismatch' };
  const res = await apiRequest(sessionRef(session.user), '/v1/session/client-mode', StartClientModeDto, {
    method: 'POST',
    body: { pin },
  });
  if (res === 'revoked') return redirect('/session/expired');
  if (!res.ok) {
    if (res.error?.code === 'VALIDATION_FAILED') return { error: 'pin_short' };
    return { error: res.status === 403 ? 'forbidden' : res.status === 429 ? 'rate_limited' : 'generic' };
  }
  await updateSession({ clientModeProof: res.data.proof });
  // The listings are what a client is shown.
  return to('/listings');
}

export async function exitClientModeAction(_prev: ClientModeFormState, form: FormData): Promise<ClientModeFormState> {
  const session = await auth();
  if (!session?.user?.id) return to('/login');
  if (!session.user.clientMode) return to('/');
  const updated = await updateSession({ clientModePin: text(form, 'pin').slice(0, 32) });
  // Too many wrong PINs: the session is gone — the member signs in again.
  if (!updated?.user?.id) return to('/login');
  if (!updated.user.clientMode) return to('/');
  return { error: updated.user.clientModeError ?? 'wrong' };
}
