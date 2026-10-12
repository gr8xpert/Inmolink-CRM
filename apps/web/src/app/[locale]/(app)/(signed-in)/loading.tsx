import { getTranslations } from 'next-intl/server';
import { PageSkeleton } from '@/components/shell/page-skeleton';

/** Shown inside the shell while a member page loads (S1-10). */
export default async function Loading() {
  const t = await getTranslations('shell');
  return <PageSkeleton label={t('loading')} />;
}
