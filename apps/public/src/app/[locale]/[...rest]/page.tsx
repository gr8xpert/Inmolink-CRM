import { notFound, permanentRedirect } from 'next/navigation';
import { legacyRedirectFor } from '@/portal/legacy';

/**
 * Unknown paths under a locale render the localized 404 inside the locale layout — after the legacy redirects
 * (S15-02: a legacy portal URL that reaches here, e.g. `/alicante` → `/en/alicante`, 301s to its new page).
 */
export default async function CatchAll({ params }: { params: Promise<{ locale: string; rest: string[] }> }) {
  const { locale, rest } = await params;
  const to = await legacyRedirectFor(`/${locale}/${rest.join('/')}`);
  if (to) permanentRedirect(to);
  notFound();
}
