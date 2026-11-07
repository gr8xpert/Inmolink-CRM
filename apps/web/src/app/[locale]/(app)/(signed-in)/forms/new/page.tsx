import { randomUUID } from 'node:crypto';
import {
  FORM_DEFAULT_CURRENCY,
  type FormTemplate,
  type ListingSummaryDto,
  VIEWING_SHEET_LISTINGS_MAX,
} from '@inmolink/contracts';
import { UI_LOCALES } from '@inmolink/i18n';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { auth } from '@/auth';
import { ClientModeUnavailable } from '@/components/shell/client-mode-unavailable';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchContact, fetchContacts } from '@/server/contacts-api';
import { fetchForms, fetchRecentListings } from '@/server/forms-api';
import { inClientMode, isActingAsMember } from '@/server/nav';
import { loadShell } from '@/server/shell';
import { ActionButton } from '../../collaborations/action-button';
import { ContactPicker } from '../../collaborations/register/contact-picker';
import { contactName } from '../../contacts/lookup';
import { createFormAction } from '../actions';
import { PlaceholderNotice, type T } from '../parts';
import { errorKey, errorOf, GENERATED_TEMPLATES, templateOf, uuidOf } from '../query';

const FORM_ID = 'generate-form';
const FIELD = 'h-9 rounded-md border bg-background px-2';

/** What each template asks the member for besides the parties (the API merges everything else from the agency's data). */
const NEEDS_LISTING: ReadonlySet<FormTemplate> = new Set(['LISTING_AGREEMENT', 'RESERVATION', 'OFFER']);

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      {/* biome-ignore lint/a11y/noLabelWithoutControl: the control is the child, which the label wraps */}
      <label className="flex flex-col gap-1">
        <span>{label}</span>
        {children}
      </label>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

/**
 * Generate a form (R2-05c): pick a template, then the fields it needs — the client (prefilled from `?contactId=`, else
 * the member's newest contacts or a lookup), the property (from `?listingId=`, else the agency's newest listings) and
 * the template's own terms. Prices, commission, parties' details and the agency's branding are merged by the API from
 * the agency's data — never typed here, never AI-written. The collaboration agreement is made from its deal room.
 */
export default async function NewFormPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const shell = await loadShell();
  if (shell && inClientMode(shell.identity)) return <ClientModeUnavailable />;
  const acting = shell ? isActingAsMember(shell.identity) : false;
  const q = await searchParams;
  const template = templateOf(q.template);
  const contactId = uuidOf(q.contactId);
  const listingId = uuidOf(q.listingId);
  const ref = sessionRef(session.user);
  const [enabled, contact, contacts, listings] = await Promise.all([
    fetchForms(ref, { limit: 1 }),
    contactId ? fetchContact(ref, contactId) : null,
    contactId ? null : fetchContacts(ref, { owner: 'me' }),
    fetchRecentListings(ref),
  ]);
  if (enabled === 'revoked' || contact === 'revoked' || contacts === 'revoked' || listings === 'revoked') {
    redirect('/session/expired');
  }
  const tt = await getTranslations('documents.dashboard');
  const t: T = (key, values) => tt(key as never, values as never);
  const tc = await getTranslations('network.collaborations');
  const error = errorOf(q.error);

  const frame = (children: ReactNode) => (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6">
      <Link href="/forms" className="text-sm underline-offset-4 hover:underline">
        {t('back')}
      </Link>
      <h1 className="text-xl font-semibold">{t('create.title')}</h1>
      {children}
    </div>
  );
  if (!enabled.ok && enabled.error?.code === 'FORMS_NOT_ENABLED') {
    return frame(
      <p role="status" className="rounded-md bg-muted p-3 text-sm">
        {t('errors.FORMS_NOT_ENABLED')}
      </p>,
    );
  }
  if (acting) return frame(<p className="text-sm text-muted-foreground">{t('actingReadOnly')}</p>);

  const keep = { ...(contactId ? { contactId } : {}), ...(listingId ? { listingId } : {}) };
  const picker = (
    <nav aria-label={t('create.template')} className="flex flex-wrap gap-2 text-sm">
      {GENERATED_TEMPLATES.map((k) => (
        <Link
          key={k}
          href={{ pathname: '/forms/new', query: { ...keep, template: k } }}
          aria-current={k === template ? 'page' : undefined}
          className={`rounded-md border px-3 py-1.5 ${k === template ? 'bg-muted font-medium' : 'hover:bg-muted/50'}`}
        >
          {t(`templates.${k}`)}
        </Link>
      ))}
    </nav>
  );
  if (!template || template === 'COLLABORATION_AGREEMENT') {
    return frame(
      <>
        <PlaceholderNotice t={t} />
        <p className="text-sm text-muted-foreground">{t('create.choose')}</p>
        {picker}
        <p className="text-sm text-muted-foreground">{t('create.collaborationFromDeal')}</p>
      </>,
    );
  }

  const ownListings: ListingSummaryDto[] = listings.ok ? listings.data.items.filter((l) => !l.deletedAt) : [];
  // the amounts are in the listing's currency: the prefilled listing's, else the one the agency's listings use (a choice
  // when they use several), else the forms' default
  const prefilled = ownListings.find((l) => l.id === listingId)?.price?.currency;
  const currencies = prefilled
    ? [prefilled]
    : [...new Set(ownListings.flatMap((l) => (l.price ? [l.price.currency] : [])))];
  const currencyField =
    currencies.length > 1 ? (
      <Field label={t('create.currency')}>
        <select name="currency" defaultValue={currencies[0]} className={FIELD}>
          {currencies.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>
    ) : (
      <input type="hidden" name="currency" value={currencies[0] ?? FORM_DEFAULT_CURRENCY} />
    );
  const listingText = (l: ListingSummaryDto) =>
    [l.ref, t(`transactions.${l.transactionType}`)].filter(Boolean).join(' · ');
  const chosenContact =
    contact?.ok === true
      ? contactName({ ...contact.data, primaryEmail: contact.data.emails[0], primaryPhone: contact.data.phones[0] })
      : null;
  const recent =
    contacts?.ok === true
      ? contacts.data.items.map((c) => ({
          id: c.id,
          name: contactName(c),
          detail: [c.primaryEmail, c.primaryPhone].filter(Boolean).join(' · '),
        }))
      : [];

  return frame(
    <>
      <PlaceholderNotice t={t} />
      {picker}
      <p className="text-sm text-muted-foreground">{t(`create.about.${template}`)}</p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorKey(error, null)}`)}
        </p>
      ) : null}

      <section aria-labelledby="h-client" className="flex flex-col gap-2 rounded-md border p-4 text-sm">
        <h2 id="h-client" className="font-medium">
          {t(template === 'LISTING_AGREEMENT' ? 'create.seller' : 'create.buyer')}
        </h2>
        {contactId ? (
          <p>
            {chosenContact ?? t('create.contactUnknown')}{' '}
            <Link
              href={{ pathname: '/forms/new', query: { template, ...(listingId ? { listingId } : {}) } }}
              className="underline-offset-4 hover:underline"
            >
              {t('create.changeContact')}
            </Link>
          </p>
        ) : (
          <ContactPicker
            formId={FORM_ID}
            recent={recent}
            recentFailed={contacts?.ok !== true}
            labels={{
              find: tc('register.find'),
              findPlaceholder: tc('register.findPlaceholder'),
              findSubmit: tc('register.findSubmit'),
              none: tc('register.findNone'),
              invalid: tc('register.findInvalid'),
              error: tc('register.findError'),
              noName: tc('row.noClient'),
              choose: tc('register.choose'),
              found: tc('register.found'),
              recent: tc('register.recent'),
              noRecent: tc('register.noRecent'),
              recentFailed: tc('register.recentFailed'),
            }}
          />
        )}
      </section>

      <form id={FORM_ID} action={createFormAction} className="flex flex-col gap-3 rounded-md border p-4 text-sm">
        <input type="hidden" name="template" value={template} />
        {template === 'VIEWING_SHEET' ? null : currencyField}
        <input type="hidden" name="idempotencyKey" value={randomUUID()} />
        {contactId ? <input type="hidden" name="contactId" value={contactId} /> : null}

        {NEEDS_LISTING.has(template) ? (
          listingId ? (
            <p>
              <input type="hidden" name="listingId" value={listingId} />
              {t('create.listing')}:{' '}
              <span className="font-medium">
                {ownListings.find((l) => l.id === listingId)?.ref ?? listingId.slice(0, 8)}
              </span>
            </p>
          ) : (
            <Field label={t('create.listing')} hint={t('create.listingHint')}>
              <select name="listingId" required defaultValue="" className={FIELD}>
                <option value="" disabled>
                  {t('create.chooseListing')}
                </option>
                {ownListings.map((l) => (
                  <option key={l.id} value={l.id}>
                    {listingText(l)}
                  </option>
                ))}
              </select>
            </Field>
          )
        ) : null}

        {template === 'VIEWING_SHEET' ? (
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1">{t('create.listings')}</legend>
            {ownListings.length === 0 ? <p className="text-muted-foreground">{t('create.noListings')}</p> : null}
            <div className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-md border p-2">
              {ownListings.slice(0, 50).map((l) => (
                <label key={l.id} className="flex items-center gap-2">
                  <input type="checkbox" name="listingIds" value={l.id} defaultChecked={l.id === listingId} />
                  <span>{listingText(l)}</span>
                </label>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">
              {t('create.listingsHint', { max: VIEWING_SHEET_LISTINGS_MAX })}
            </span>
          </fieldset>
        ) : null}

        {template === 'LISTING_AGREEMENT' ? (
          <>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="exclusive" />
              <span>{t('create.exclusive')}</span>
            </label>
            <Field label={t('create.termMonths')}>
              <input name="termMonths" type="number" min={1} max={36} defaultValue={6} required className={FIELD} />
            </Field>
          </>
        ) : null}

        {template === 'RESERVATION' ? (
          <>
            <Field label={t('create.price')} hint={t('create.priceHint')}>
              <input name="price" inputMode="decimal" autoComplete="off" className={FIELD} />
            </Field>
            <Field label={t('create.deposit')} hint={t('create.amountHint')}>
              <input name="deposit" required inputMode="decimal" autoComplete="off" className={FIELD} />
            </Field>
            <Field label={t('create.holdDays')}>
              <input name="holdDays" type="number" min={1} max={180} defaultValue={30} required className={FIELD} />
            </Field>
          </>
        ) : null}

        {template === 'VIEWING_SHEET' ? (
          <Field label={t('create.visitedOn')}>
            <input name="visitedOn" type="date" required className={FIELD} />
          </Field>
        ) : null}

        {template === 'OFFER' ? (
          <>
            <Field label={t('create.offer')} hint={t('create.amountHint')}>
              <input name="offer" required inputMode="decimal" autoComplete="off" className={FIELD} />
            </Field>
            <Field label={t('create.validUntil')}>
              <input name="validUntil" type="date" required className={FIELD} />
            </Field>
            <Field label={t('create.conditions')} hint={t('create.conditionsHint')}>
              <textarea name="conditions" maxLength={1000} rows={3} className="rounded-md border bg-background p-2" />
            </Field>
          </>
        ) : null}

        <Field label={t('create.language')}>
          <select name="locale" defaultValue={locale} className={FIELD}>
            {UI_LOCALES.map((l) => (
              <option key={l} value={l}>
                {t(`languages.${l}`)}
              </option>
            ))}
          </select>
        </Field>
        <div>
          <ActionButton variant="default" label={t('create.submit')} />
        </div>
      </form>
    </>,
  );
}
