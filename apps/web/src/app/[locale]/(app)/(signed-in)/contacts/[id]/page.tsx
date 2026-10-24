import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchContact, fetchContactNotes } from '@/server/contacts-api';
import { addNoteAction } from '../actions';
import { ContactFinder } from '../contact-finder';
import { contactName } from '../lookup';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;
const DONE = ['merged', 'noted'] as const;
const ERRORS = ['generic', 'VERSION_CONFLICT', 'VALIDATION_FAILED', 'FORBIDDEN', 'CONTACT_NOT_FOUND'] as const;
const CONTACT_ERRORS = [
  'CONTACT_NOT_FOUND',
  'CONTACT_MERGE_INVALID',
  'CONTACT_MERGE_LIMIT',
  'CONTACT_DUPLICATE',
] as const;

/**
 * One contact (S11-F14): details and consent, notes, and the merge of a duplicate into it. The duplicate is found by
 * its e-mail or phone (a POST server action: never in a URL); merging asks the API, which lets admins do it and refuses others.
 */
export default async function ContactPage({
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
  if (!UUID.test(id)) return localeRedirect({ href: '/contacts', locale });
  const q = await searchParams;
  const ref = sessionRef(session.user);
  const t = await getTranslations('contacts');
  const format = await getFormatter();
  const cursor = typeof q.notes === 'string' && CURSOR.test(q.notes) ? q.notes : undefined;
  const [contact, notes] = await Promise.all([fetchContact(ref, id), fetchContactNotes(ref, id, cursor)]);
  if (contact === 'revoked' || notes === 'revoked') redirect('/session/expired');
  const back = (
    <Link href="/contacts" className="text-sm underline-offset-4 hover:underline">
      {t('detail.back')}
    </Link>
  );
  if (!contact.ok) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
        {back}
        <p role="alert" className="text-sm text-destructive">
          {contact.status === 404 ? t('errors.CONTACT_NOT_FOUND') : t('errors.generic')}
        </p>
      </div>
    );
  }
  const c = contact.data;
  const done = (DONE as readonly string[]).includes(q.done ?? '') ? (q.done as (typeof DONE)[number]) : null;
  const errorCode = q.error
    ? ([...ERRORS, ...CONTACT_ERRORS] as readonly string[]).includes(q.error)
      ? q.error
      : 'generic'
    : null;
  const yesNo = (v: boolean) => (v ? t('detail.yes') : t('detail.no'));
  const list = (v: string[]) => (v.length ? v.join(', ') : t('detail.none'));
  const rows: Array<[string, string]> = [
    [t('fields.emails'), list(c.emails)],
    [t('fields.phones'), list(c.phones)],
    [t('fields.types'), c.types.length ? c.types.map((v) => t(`types.${v}`)).join(', ') : t('detail.none')],
    [t('fields.source'), t(`sources.${c.source}`)],
    [t('fields.tags'), list(c.tags)],
    [t('fields.consentMarketing'), yesNo(c.consentMarketing)],
    [t('fields.consentProcessing'), yesNo(c.consentProcessing)],
    [t('fields.doNotContact'), yesNo(c.doNotContact)],
  ];

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">
          {contactName({ ...c, primaryEmail: c.emails[0], primaryPhone: c.phones[0] }) ?? t('list.noName')}
        </h1>
        {back}
      </div>
      <p className="text-sm text-muted-foreground">
        {t('detail.since', { date: format.dateTime(new Date(c.createdAt), { dateStyle: 'medium' }) })}
      </p>
      {done ? (
        <p role="status" className="text-sm">
          {t(`detail.done.${done}`)}
        </p>
      ) : null}
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorCode as 'generic'}`)}
        </p>
      ) : null}

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="notes" className="flex flex-col gap-2">
        <h2 id="notes" className="text-base font-semibold">
          {t('detail.notes.title')}
        </h2>
        <form action={addNoteAction} className="flex flex-col gap-2 text-sm">
          <input type="hidden" name="id" value={c.id} />
          <label className="flex flex-col gap-1">
            <span>{t('detail.notes.input')}</span>
            <textarea name="body" required rows={3} maxLength={4000} className="rounded-md border bg-background p-2" />
          </label>
          <button type="submit" className="h-9 self-start rounded-md border px-3 font-medium">
            {t('detail.notes.add')}
          </button>
        </form>
        {notes.ok && notes.data.items.length > 0 ? (
          <ul className="divide-y rounded-md border text-sm">
            {notes.data.items.map((n) => (
              <li key={n.id} className="flex flex-col gap-1 p-3">
                <span className="whitespace-pre-wrap">{n.body}</span>
                <span className="text-xs text-muted-foreground">
                  {format.dateTime(new Date(n.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t('detail.notes.empty')}</p>
        )}
        {notes.ok && notes.data.nextCursor ? (
          <Link
            href={{ pathname: `/contacts/${c.id}`, query: { notes: notes.data.nextCursor } }}
            className="text-sm font-medium underline-offset-4 hover:underline"
          >
            {t('detail.notes.loadMore')}
          </Link>
        ) : null}
      </section>

      <section aria-labelledby="merge" className="flex flex-col gap-2 rounded-md border p-4 text-sm">
        <h2 id="merge" className="text-base font-semibold">
          {t('merge.title')}
        </h2>
        <p className="text-muted-foreground">{t('merge.body')}</p>
        <ContactFinder
          mode={{ kind: 'merge', id: c.id, version: c.version }}
          labels={{
            title: t('detail.merge.find'),
            input: t('list.find.input'),
            submit: t('detail.merge.submit'),
            none: t('detail.merge.none'),
            invalid: t('list.find.invalid'),
            error: t('list.load'),
            noName: t('list.noName'),
            merge: t('merge.confirm'),
          }}
        />
      </section>
    </div>
  );
}
