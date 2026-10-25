'use server';

import { GrantPlanBody, PlanGrantParams, PriceLockBody, RevokePlanGrantBody, TenantParams } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { grantPlan, revokePlanGrant, setPriceLock } from '@/server/staff-ops-api';

/** Plan grants and price locks (S13-03, transport only): super admins; the API authorizes and audits. */
const KNOWN_ERRORS = [
  'FORBIDDEN',
  'BILLING_PRICE_UNAVAILABLE',
  'BILLING_GRANT_NOT_FOUND',
  'VALIDATION_FAILED',
] as const;

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};

/** A `date` input (YYYY-MM-DD) → the end of that day, UTC. */
const endOfDay = (v: string | undefined) => (v ? `${v}T23:59:59Z` : undefined);

async function session() {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  return sessionRef(s.user);
}

async function back(agencyId: string, query: Record<string, string>): Promise<never> {
  const path = getPathname({ href: `/staff/tenants/${agencyId}`, locale: await getLocale() });
  redirect(`${path}?${new URLSearchParams(query)}#billing`);
}

function agencyOf(form: FormData): string {
  const tenant = TenantParams.safeParse({ agencyId: text(form, 'agencyId') });
  if (!tenant.success) redirect('/');
  return tenant.data.agencyId;
}

type Result = Awaited<ReturnType<typeof grantPlan>> | Awaited<ReturnType<typeof setPriceLock>>;

async function finish(agencyId: string, res: Result, notice: string): Promise<never> {
  if (res === 'revoked') redirect('/session/expired');
  if (res.ok) return back(agencyId, { billingNotice: notice });
  return back(agencyId, { billingError: KNOWN_ERRORS.find((c) => c === res.error?.code) ?? 'generic' });
}

export async function grantPlanAction(form: FormData): Promise<void> {
  const agencyId = agencyOf(form);
  const body = GrantPlanBody.safeParse({
    agencyId,
    planCode: text(form, 'planCode'),
    endsAt: endOfDay(text(form, 'endsAt')),
    reason: text(form, 'reason'),
  });
  if (!body.success) return back(agencyId, { billingError: 'VALIDATION_FAILED' });
  return finish(agencyId, await grantPlan(await session(), body.data), 'granted');
}

export async function revokePlanGrantAction(form: FormData): Promise<void> {
  const agencyId = agencyOf(form);
  const params = PlanGrantParams.safeParse({ id: text(form, 'grantId') });
  const body = RevokePlanGrantBody.safeParse({ reason: text(form, 'reason') });
  if (!params.success || !body.success) return back(agencyId, { billingError: 'VALIDATION_FAILED' });
  return finish(agencyId, await revokePlanGrant(await session(), params.data.id, body.data), 'revoked');
}

export async function setPriceLockAction(form: FormData): Promise<void> {
  const agencyId = agencyOf(form);
  const amount = Number(text(form, 'amount'));
  const body = PriceLockBody.safeParse({
    agencyId,
    planCode: text(form, 'planCode'),
    interval: text(form, 'interval'),
    currency: text(form, 'currency'),
    amountCents: Number.isFinite(amount) ? Math.round(amount * 100) : Number.NaN,
    endsAt: endOfDay(text(form, 'endsAt')),
    reason: text(form, 'reason'),
  });
  if (!body.success) return back(agencyId, { billingError: 'VALIDATION_FAILED' });
  return finish(agencyId, await setPriceLock(await session(), body.data), 'locked');
}
