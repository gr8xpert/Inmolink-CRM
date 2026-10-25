'use server';

import { FeatureFlagParams, SetFeatureFlagBody } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { setFeatureFlag } from '@/server/staff-ops-api';

/** Feature flags (S13-03, transport only): super admins set a default or an agency override; the API audits it. */
const KNOWN_ERRORS = ['FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'] as const;

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};

async function back(query: Record<string, string>): Promise<never> {
  const path = getPathname({ href: '/staff/flags', locale: await getLocale() });
  redirect(`${path}?${new URLSearchParams(query)}`);
}

export async function setFeatureFlagAction(form: FormData): Promise<void> {
  const params = FeatureFlagParams.safeParse({ key: text(form, 'key') });
  const value = text(form, 'value');
  const agencyId = text(form, 'agencyId');
  const body = SetFeatureFlagBody.safeParse(
    form.get('scope') === 'agency'
      ? { agencyId, override: value === 'on' ? true : value === 'off' ? false : null }
      : { enabled: value === 'on' },
  );
  if (!params.success || !body.success) return back({ error: 'VALIDATION_FAILED' });
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  const res = await setFeatureFlag(sessionRef(s.user), params.data.key, body.data);
  if (res === 'revoked') redirect('/session/expired');
  if (res.ok) return back({ notice: 'saved' });
  return back({ error: KNOWN_ERRORS.find((c) => c === res.error?.code) ?? 'generic' });
}
