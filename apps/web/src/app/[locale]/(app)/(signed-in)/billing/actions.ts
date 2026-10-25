'use server';

import { BillingCurrency, BillingInterval, CatalogCode } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { openPortal, startCheckout } from '@/server/billing-api';
import { BILLING_NOTICE_ERRORS } from './errors';

/**
 * Billing forms (S13-01, transport only): subscribe to a plan (off to Stripe Checkout) and manage the subscription (off
 * to the Customer Portal). Plain forms: they work without JavaScript. Errors come back as `?error=` (i18n keys under
 * `billing.errors`). The Stripe URLs come from the API, never from the browser.
 */

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

const back = async (query: Record<string, string>): Promise<never> =>
  redirect(`${getPathname({ href: '/billing', locale: await getLocale() })}?${new URLSearchParams(query).toString()}`);

const known = (code: string | undefined) => BILLING_NOTICE_ERRORS.find((c) => c === code) ?? 'generic';

async function session() {
  const s = await auth();
  if (!s?.user?.id) return redirect(getPathname({ href: '/login', locale: await getLocale() }));
  return sessionRef(s.user);
}

export async function subscribeAction(form: FormData): Promise<void> {
  const planCode = CatalogCode.safeParse(text(form, 'planCode'));
  // `INTERVAL:CURRENCY` — one radio per price (annual EUR by default).
  const [rawInterval, rawCurrency] = (text(form, 'price') || 'YEAR:EUR').split(':');
  const interval = BillingInterval.safeParse(rawInterval);
  const currency = BillingCurrency.safeParse(rawCurrency);
  if (!planCode.success || !interval.success || !currency.success) return back({ error: 'generic' });
  const res = await startCheckout(await session(), {
    planCode: planCode.data,
    interval: interval.data,
    currency: currency.data,
    addons: [],
  });
  if (res === 'revoked') return redirect('/session/expired');
  if (!res.ok) return back({ error: known(res.error?.code) });
  return redirect(res.data.url);
}

export async function managePortalAction(): Promise<void> {
  const res = await openPortal(await session());
  if (res === 'revoked') return redirect('/session/expired');
  if (!res.ok) return back({ error: known(res.error?.code) });
  return redirect(res.data.url);
}
