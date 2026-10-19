'use server';

import {
  ImpersonationParams,
  SetGiveToGetExemptionBody,
  StartImpersonationBody,
  TenantParams,
} from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { forgetImpersonation, readImpersonation, rememberImpersonation } from '@/server/impersonation';
import { endImpersonation, fetchStaffMe, setGiveToGetExemption, startImpersonation } from '@/server/staff-api';

/**
 * Impersonation actions (S1-09, transport only). The API decides who may impersonate whom and records
 * it; the browser keeps the open session in an httpOnly cookie for the banner and the token mint.
 */
const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v : undefined;
};

async function session() {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  return sessionRef(s.user);
}

const KNOWN_ERRORS = ['FORBIDDEN', 'NOT_FOUND', 'IMPERSONATION_TARGET_INVALID', 'VALIDATION_FAILED'] as const;

async function toTenant(agencyId: string, query: Record<string, string>): Promise<never> {
  const path = getPathname({ href: `/staff/tenants/${agencyId}`, locale: await getLocale() });
  redirect(`${path}?${new URLSearchParams(query)}`);
}

/** Starts acting as a member (reason required) and opens the dashboard as them. */
export async function startImpersonationAction(form: FormData): Promise<void> {
  const tenant = TenantParams.safeParse({ agencyId: text(form, 'agencyId') });
  if (!tenant.success) redirect('/');
  const { agencyId } = tenant.data;
  const body = StartImpersonationBody.safeParse({
    agencyId: agencyId,
    userId: text(form, 'userId'),
    reason: text(form, 'reason'),
    minutes: Number(text(form, 'minutes') ?? 30),
  });
  if (!body.success) return toTenant(agencyId, { error: 'VALIDATION_FAILED' });
  const s = await session();
  const res = await startImpersonation(s, body.data);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) {
    return toTenant(agencyId, { error: KNOWN_ERRORS.find((c) => c === res.error?.code) ?? 'generic' });
  }
  await rememberImpersonation(s.userId, res.data);
  redirect(getPathname({ href: '/', locale: await getLocale() }));
}

/**
 * Ends the open session (banner button) on the server first; the browser forgets it only once the API
 * confirms (204) or says it was already over (404). Otherwise the banner stays and the error shows.
 */
export async function endImpersonationAction(): Promise<void> {
  const s = await session();
  const open = await readImpersonation(s.userId, { includeExpired: true });
  if (!open) {
    await forgetImpersonation();
    redirect(getPathname({ href: '/staff/tenants', locale: await getLocale() }));
  }
  const res = await endImpersonation(s, open.id);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok && res.status !== 404) return toTenant(open.agencyId, { error: 'generic' });
  await forgetImpersonation();
  return toTenant(open.agencyId, { notice: 'impersonationEnded' });
}

/**
 * The banner's "dismiss" for a session that already ended elsewhere (expired, revoked, ended in another
 * tab): forgets it only after `GET /v1/staff/me` confirms it is no longer live.
 */
export async function dismissEndedImpersonationAction(): Promise<void> {
  const s = await session();
  const stored = await readImpersonation(s.userId, { includeExpired: true });
  const me = await fetchStaffMe(s);
  if (me === 'revoked') redirect('/session/expired');
  const live = me.ok && stored !== null && me.data.impersonation?.id === stored.id;
  if (!live && (me.ok || me.status === 403)) await forgetImpersonation();
  redirect(getPathname({ href: live ? '/' : '/staff/tenants', locale: await getLocale() }));
}

/** A super admin ends another staff member's live session (S1-F9); the API refuses every other role. */
export async function endSessionAsSuperAdminAction(form: FormData): Promise<void> {
  const params = ImpersonationParams.safeParse({ id: text(form, 'id') });
  if (!params.success) redirect(getPathname({ href: '/staff/sessions', locale: await getLocale() }));
  const s = await session();
  const res = await endImpersonation(s, params.data.id);
  if (res === 'revoked') redirect('/session/expired');
  const path = getPathname({ href: '/staff/sessions', locale: await getLocale() });
  redirect(res.ok || res.status === 404 ? `${path}?notice=ended` : path);
}

/** Give-to-get exemption (S5-05, S6-F1): support flags a buyer-only agency with a reason; the API decides who may and audits it. */
export async function setGiveToGetExemptionAction(form: FormData): Promise<void> {
  const tenant = TenantParams.safeParse({ agencyId: text(form, 'agencyId') });
  if (!tenant.success) redirect('/');
  const body = SetGiveToGetExemptionBody.safeParse({
    exempt: text(form, 'exempt') === 'true',
    reason: text(form, 'reason'),
  });
  if (!body.success) return toTenant(tenant.data.agencyId, { error: 'VALIDATION_FAILED' });
  const res = await setGiveToGetExemption(await session(), tenant.data.agencyId, body.data);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) {
    return toTenant(tenant.data.agencyId, { error: KNOWN_ERRORS.find((c) => c === res.error?.code) ?? 'generic' });
  }
  return toTenant(tenant.data.agencyId, {});
}
