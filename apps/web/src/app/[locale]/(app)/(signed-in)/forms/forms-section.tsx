import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import type { SessionRef } from '@/server/api';
import { fetchForms } from '@/server/forms-api';
import { FormList, type T } from './parts';

/**
 * A contact's or a listing's forms (R2-05c): the newest five, all of them on `/forms`, and "generate a form" with the
 * contact or listing prefilled. Nothing while `documents.forms` is off (the API answers FORMS_NOT_ENABLED).
 */
export async function FormsSection({
  session,
  scope,
}: {
  session: SessionRef;
  scope: { contactId: string } | { listingId: string };
}) {
  const res = await fetchForms(session, { ...scope, limit: 5 });
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok && (res.error?.code === 'FORMS_NOT_ENABLED' || res.status === 403)) return null;
  const tt = await getTranslations('documents.dashboard');
  const t: T = (key, values) => tt(key as never, values as never);
  const format = await getFormatter();
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });
  const kind = 'contactId' in scope ? 'contact' : 'listing';
  return (
    <section aria-labelledby="h-forms" className="flex flex-col gap-2 rounded-md border p-4 text-sm">
      <h2 id="h-forms" className="text-base font-semibold">
        {t('section.title')}
      </h2>
      {res.ok ? (
        <FormList items={res.data.items} t={t} date={date} />
      ) : (
        <p role="alert" className="text-destructive">
          {t('errors.load')}
        </p>
      )}
      <div className="flex flex-wrap gap-4">
        <Link
          href={{ pathname: '/forms/new', query: scope }}
          className="font-medium underline-offset-4 hover:underline"
        >
          {t('new')}
        </Link>
        {res.ok && res.data.items.length > 0 ? (
          <Link href={{ pathname: '/forms', query: scope }} className="underline-offset-4 hover:underline">
            {t(`section.all.${kind}`)}
          </Link>
        ) : null}
      </div>
    </section>
  );
}
