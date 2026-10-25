'use server';

import { AiFeature } from '@inmolink/contracts';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { redirect } from '@/i18n/navigation';
import { saveAgencyAiFeature, sessionRef } from '@/server/api';

/**
 * AI feature toggle action (S13-F17, transport only): one feature on or off per submission through
 * `PUT /v1/agency/ai-features/:feature` (the API authorizes and audits). Back to the page with the outcome.
 */
export async function setAiFeatureAction(form: FormData): Promise<void> {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return redirect({ href: '/login', locale });
  const feature = AiFeature.safeParse(form.get('feature'));
  const enabled = form.get('enabled') === 'true';
  if (!feature.success) return redirect({ href: { pathname: '/settings/ai', query: { error: 'generic' } }, locale });
  const res = await saveAgencyAiFeature(sessionRef(session.user), feature.data, enabled);
  if (res === 'revoked') return redirect({ href: '/login', locale });
  const outcome = res.ok ? { saved: '1' } : { error: res.status === 403 ? 'forbidden' : 'generic' };
  return redirect({ href: { pathname: '/settings/ai', query: outcome }, locale });
}
