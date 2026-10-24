import { CONTACT_TYPES, type ContactListItemDto, type ContactType } from '@inmolink/contracts';
import { EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchContacts } from '@/server/contacts-api';
import { ContactFinder } from './contact-finder';
import { contactName } from './lookup';

const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;

/**
 * Contacts (S11-F14, PLAN §7 M8): the agency's contacts, newest first with a type and "mine" filter, and a find box that
 * looks a person up by exact e-mail or phone (a POST server action, so the value never sits in a URL, the history or an
 * access log). Server-rendered apart from that one small find island.
 */
export default async function ContactsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const params = await searchParams;
  const type = (CONTACT_TYPES as readonly string[]).includes(params.type ?? '')
    ? (params.type as ContactType)
    : undefined;
  const owner = params.owner === 'me' ? 'me' : undefined;
  const cursor = typeof params.cursor === 'string' && CURSOR.test(params.cursor) ? params.cursor : undefined;
  const ref = sessionRef(session.user);
  const t = await getTranslations('contacts');

  const res = await fetchContacts(ref, { type, owner, cursor });
  if (res === 'revoked') redirect('/session/expired');
  const items: ContactListItemDto[] | null = res.ok ? res.data.items : null;
  const nextCursor = res.ok ? res.data.nextCursor : null;
  const failed = !res.ok;

  return (
    <div className="flex flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('list.subtitle')}</p>

      <div className="rounded-md border p-3">
        <ContactFinder
          mode={{ kind: 'link' }}
          labels={{
            title: t('list.find.title'),
            input: t('list.find.input'),
            submit: t('list.find.submit'),
            none: t('list.find.none'),
            invalid: t('list.find.invalid'),
            error: t('list.load'),
            noName: t('list.noName'),
            merge: t('merge.confirm'),
          }}
        />
      </div>

      {
        <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span>{t('list.filters.type')}</span>
            <select name="type" defaultValue={type ?? ''} className="h-9 rounded-md border bg-background px-2">
              <option value="">{t('list.filters.anyType')}</option>
              {CONTACT_TYPES.map((v) => (
                <option key={v} value={v}>
                  {t(`types.${v}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('list.filters.owner')}</span>
            <select name="owner" defaultValue={owner ?? ''} className="h-9 rounded-md border bg-background px-2">
              <option value="">{t('list.filters.anyone')}</option>
              <option value="me">{t('list.filters.mine')}</option>
            </select>
          </label>
          <button type="submit" className="h-9 rounded-md border px-3 font-medium">
            {t('list.filters.apply')}
          </button>
        </form>
      }

      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          {t('list.load')}
        </p>
      ) : items === null ? null : items.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-sm" data-testid="contact-list">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="p-2 font-medium">{t('list.columns.name')}</th>
                <th className="p-2 font-medium">{t('list.columns.email')}</th>
                <th className="p-2 font-medium">{t('list.columns.phone')}</th>
                <th className="p-2 font-medium">{t('list.columns.type')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map((c) => (
                <tr key={c.id}>
                  <td className="p-2">
                    <Link href={`/contacts/${c.id}`} className="font-medium underline-offset-4 hover:underline">
                      {contactName(c) ?? t('list.noName')}
                    </Link>
                    {c.doNotContact ? (
                      <span className="ml-2 text-xs text-destructive">{t('list.doNotContact')}</span>
                    ) : null}
                  </td>
                  <td className="p-2">{c.primaryEmail ?? ''}</td>
                  <td className="p-2">{c.primaryPhone ?? ''}</td>
                  <td className="p-2">{c.types.map((v) => t(`types.${v}`)).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nextCursor ? (
        <Link
          href={{
            pathname: '/contacts',
            query: { ...(type ? { type } : {}), ...(owner ? { owner } : {}), cursor: nextCursor },
          }}
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('list.loadMore')}
        </Link>
      ) : null}
    </div>
  );
}
