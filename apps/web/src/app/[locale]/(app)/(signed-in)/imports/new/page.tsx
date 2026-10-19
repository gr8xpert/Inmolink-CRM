import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { redirect as localeRedirect } from '@/i18n/navigation';
import { fetchMappingProfiles, sessionRef } from '@/server/api';
import { ConnectionForm } from '../connection-form';
import { ImportNotice } from '../shared';

/** Connect a Kyero feed (S6-03). Admins only; the API refuses everyone else. */
export default async function NewFeedPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const q = await searchParams;
  const profiles = await fetchMappingProfiles(sessionRef(session.user));
  const t = await getTranslations('imports.form');
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">{t('createTitle')}</h1>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <ImportNotice error={q.error} />
      <ConnectionForm
        profiles={
          profiles !== 'revoked' && profiles.ok ? profiles.data.items.map((p) => ({ id: p.id, name: p.name })) : []
        }
        prefill={{ connector: q.connector, profile: q.profile, url: q.url }}
      />
    </div>
  );
}
