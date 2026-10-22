import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
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
      <nav aria-label={t('format')} className="flex gap-4 text-sm">
        <Link
          href="/imports/new"
          className={q.connector === 'resales-online' ? 'underline-offset-4 hover:underline' : 'font-medium'}
        >
          {t('formats.kyero')} / {t('formats.xml-mapped')}
        </Link>
        <Link
          href={{ pathname: '/imports/new', query: { connector: 'resales-online' } }}
          className={q.connector === 'resales-online' ? 'font-medium' : 'underline-offset-4 hover:underline'}
        >
          {t('formats.resales-online')}
        </Link>
      </nav>
      <ImportNotice error={q.error} detail={q.detail} />
      <ConnectionForm
        profiles={
          profiles !== 'revoked' && profiles.ok ? profiles.data.items.map((p) => ({ id: p.id, name: p.name })) : []
        }
        prefill={{ connector: q.connector, profile: q.profile, url: q.url }}
      />
    </div>
  );
}
