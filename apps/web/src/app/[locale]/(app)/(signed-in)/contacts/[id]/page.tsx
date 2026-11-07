import { CLIENT_PROFILE_LIMITS } from '@inmolink/contracts';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchTaxonomy, sessionRef } from '@/server/api';
import { fetchContactConsents } from '@/server/compliance-api';
import { fetchContact, fetchContactNotes } from '@/server/contacts-api';
import { fetchClientProfiles } from '@/server/matching-api';
import { FormsSection } from '../../forms/forms-section';
import { listingTaxonomy } from '../../listings/taxonomy';
import { addNoteAction } from '../actions';
import { ContactFinder } from '../contact-finder';
import { contactName } from '../lookup';
import { ClientProfiles } from './client-profiles';
import { ConsentHistory } from './consent-history';
import { deleteProfileAction, saveProfileAction } from './profile-actions';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;
const DONE = ['merged', 'noted', 'edited'] as const;
/** R2-02d: the profile form's outcomes (`contacts.profiles.done`). */
const PROFILE_DONE = ['profileSaved', 'profileDeleted'] as const;
const ERRORS = ['generic', 'VERSION_CONFLICT', 'VALIDATION_FAILED', 'FORBIDDEN', 'CONTACT_NOT_FOUND'] as const;
const CONTACT_ERRORS = [
  'CLIENT_PROFILE_NOT_FOUND',
  'CLIENT_PROFILE_LIMIT',
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
  const [contact, notes, consents, profiles, tax] = await Promise.all([
    fetchContact(ref, id),
    fetchContactNotes(ref, id, cursor),
    fetchContactConsents(ref, id),
    fetchClientProfiles(ref, id),
    fetchTaxonomy(ref),
  ]);
  if (
    contact === 'revoked' ||
    notes === 'revoked' ||
    consents === 'revoked' ||
    profiles === 'revoked' ||
    tax === 'revoked'
  ) {
    redirect('/session/expired');
  }
  const tp = await getTranslations('contacts.profiles');
  const back = (
    <Link href="/contacts" className="text-sm underline-offset-4 hover:underline">
      {t('detail.back')}
    </Link>
  );
  // S17-F40: an unknown, foreign or merged contact is the same "Page not found" as any other unknown page.
  if (!contact.ok && contact.status === 404) notFound();
  if (!contact.ok) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
        {back}
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      </div>
    );
  }
  const c = contact.data;
  const done = (DONE as readonly string[]).includes(q.done ?? '') ? (q.done as (typeof DONE)[number]) : null;
  const profileDone = PROFILE_DONE.find((d) => d === q.done) ?? null;
  const profileItems = profiles.ok ? profiles.data.items : null;
  const editing = (q.profile && profileItems?.find((p) => p.id === q.profile)) || null;
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
        <div className="flex items-center gap-4">
          <Link href={`/contacts/${c.id}/edit`} className="text-sm font-medium underline-offset-4 hover:underline">
            {t('edit.link')}
          </Link>
          {back}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        {t('detail.since', { date: format.dateTime(new Date(c.createdAt), { dateStyle: 'medium' }) })}
      </p>
      {done ? (
        <p role="status" className="text-sm">
          {t(`detail.done.${done}`)}
        </p>
      ) : null}
      {profileDone ? (
        <p role="status" className="text-sm">
          {tp(`done.${profileDone}`)}
        </p>
      ) : null}
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorCode as 'generic'}`, { max: CLIENT_PROFILE_LIMITS.perContact })}
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

      {/* S16-F5: the consent records (append-only, S16-04) */}
      <ConsentHistory
        items={consents.ok ? consents.data.items : null}
        formatDate={(d) => format.dateTime(d, { dateStyle: 'medium', timeStyle: 'short' })}
        labels={{
          title: t('consents.title'),
          empty: t('consents.empty'),
          load: t('consents.load'),
          purpose: { MARKETING: t('consents.purposes.MARKETING'), PROCESSING: t('consents.purposes.PROCESSING') },
          granted: t('consents.granted'),
          withdrawn: t('consents.withdrawn'),
          source: {
            DASHBOARD: t('consents.sources.DASHBOARD'),
            WEBSITE: t('consents.sources.WEBSITE'),
            PORTAL: t('consents.sources.PORTAL'),
            IMPORT: t('consents.sources.IMPORT'),
            MERGE: t('consents.sources.MERGE'),
            UNSUBSCRIBE_LINK: t('consents.sources.UNSUBSCRIBE_LINK'),
          },
          byMember: t('consents.byMember'),
          impersonated: t('consents.impersonated'),
          policy: (version) => t('consents.policy', { version }),
        }}
      />

      {/* R2-02d: the client's search profiles and a way into their matches */}
      <ClientProfiles
        contactId={c.id}
        profiles={profileItems}
        editing={editing}
        conflict={editing !== null && q.error === 'VERSION_CONFLICT'}
        confirmDelete={q.confirmDelete ?? null}
        tax={listingTaxonomy(tax.ok ? tax.data : null)}
        t={(key, values) => tp(key as never, values as never)}
        euros={(cents) => format.number(cents / 100, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })}
        actions={{ save: saveProfileAction, delete: deleteProfileAction }}
      />
      <Link
        href={{ pathname: '/matches', query: { contact: c.id } }}
        className="self-start text-sm font-medium underline-offset-4 hover:underline"
      >
        {t('matchQueue.link')}
      </Link>

      {/* R2-05c: the contact's forms (hidden while the forms library is off) */}
      <FormsSection session={ref} scope={{ contactId: c.id }} />

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
