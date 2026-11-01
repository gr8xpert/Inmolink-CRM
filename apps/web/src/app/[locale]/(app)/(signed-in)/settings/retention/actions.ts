'use server';

import { UpdateRetentionSettingsBody } from '@inmolink/contracts';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { redirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { saveRetention } from '@/server/compliance-api';

/**
 * Retention period action (S16-F5, transport only): the admin's new period (blank or "off" = never) with a fresh
 * second-factor code, which the API verifies before anything changes. Back to the page with the outcome (error codes:
 * `agency.retention.errors.*`).
 */

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

export async function saveRetentionAction(form: FormData): Promise<void> {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return redirect({ href: '/login', locale });
  const back = (query: Record<string, string>) =>
    redirect({ href: { pathname: '/settings/retention', query }, locale });
  const off = form.get('off') === 'on';
  const raw = text(form, 'months');
  const months = off || raw === '' ? null : Number(raw);
  const parsed = UpdateRetentionSettingsBody.safeParse({
    inactiveContactMonths: months,
    twoFactorCode: text(form, 'twoFactorCode'),
  });
  if (!parsed.success) {
    const codeProblem = parsed.error.issues.some((i) => i.path[0] === 'twoFactorCode');
    return back({ error: codeProblem ? 'MFA_CODE_INVALID' : 'VALIDATION_FAILED' });
  }
  const res = await saveRetention(sessionRef(session.user), parsed.data);
  if (res === 'revoked') return redirect({ href: '/login', locale });
  if (res.ok) return back({ saved: '1' });
  return back({ error: res.status === 403 ? 'FORBIDDEN' : (res.error?.code ?? 'generic') });
}
