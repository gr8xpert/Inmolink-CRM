import { getTranslations } from 'next-intl/server';
import { PageSkeleton } from '@/components/shell/page-skeleton';

/**
 * Shown inside the shell while a member page loads (S1-10).
 *
 * S17-F40: this boundary streams the page, so a `notFound()` inside it renders "Page not found" (with `noindex`) under
 * HTTP 200: Next cannot change a status after the first byte. A real 404 would need the existence check before the
 * stream (the proxy) or no skeleton; member pages are behind login and not indexed, so the skeleton is kept.
 */
export default async function Loading() {
  const t = await getTranslations('shell');
  return <PageSkeleton label={t('loading')} />;
}
