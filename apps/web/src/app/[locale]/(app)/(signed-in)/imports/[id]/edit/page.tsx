import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { redirect as localeRedirect } from '@/i18n/navigation';
import { fetchFeedConnection, fetchMappingProfiles, sessionRef } from '@/server/api';
import { ConnectionForm } from '../../connection-form';
import { ImportNotice } from '../../shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Edit a feed connection (S6-03). Admins only; the API refuses everyone else. */
export default async function EditFeedPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const res = await fetchFeedConnection(sessionRef(session.user), id);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok && res.status === 404) notFound();
  const profiles =
    res.ok && res.data.connector === 'xml-mapped' ? await fetchMappingProfiles(sessionRef(session.user)) : null;
  const t = await getTranslations('imports');
  const q = await searchParams;
  if (!res.ok) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">{t('form.editTitle', { name: res.data.name })}</h1>
      <ImportNotice error={q.error} />
      <ConnectionForm
        connection={res.data}
        profiles={
          profiles && profiles !== 'revoked' && profiles.ok
            ? profiles.data.items.map((p) => ({ id: p.id, name: p.name }))
            : []
        }
      />
    </div>
  );
}
