import {
  SAVED_SEARCH_ALERT_KINDS,
  SAVED_SEARCH_FREQUENCIES,
  SAVED_SEARCH_LIMITS,
  SAVED_SEARCH_SCOPES,
  TRANSACTION_TYPES,
} from '@inmolink/contracts';
import { EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchTaxonomy, sessionRef } from '@/server/api';
import { fetchSavedSearches } from '@/server/matching-api';
import { listingTaxonomy } from '../../listings/taxonomy';
import { parseNetworkState } from '../query';
import { createSavedSearchAction, deleteSavedSearchAction } from './actions';

const ERRORS = [
  'generic',
  'VALIDATION_FAILED',
  'FORBIDDEN',
  'RATE_LIMITED',
  'SAVED_SEARCH_NOT_FOUND',
  'SAVED_SEARCH_LIMIT',
] as const;
const DONE = ['saved', 'deleted'] as const;
const FIELD = 'h-9 rounded-md border bg-background px-2';

/**
 * Saved searches (S5-06, PLAN §7 M9): the agent's own searches of the agency's and the network's listings, with alerts
 * when a listing is new on the market, drops its price or comes back on the market — at once or in a daily digest,
 * in the notification bell and the e-mail summary. Server-rendered (no client JS of its own); every rule is the
 * API's. The network search's filters (`type`, `location`, `min`, `max`, `beds` in the URL) prefill a new one.
 */
export default async function SavedSearchesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const q = await searchParams;
  const prefill = parseNetworkState(q);
  const done = DONE.find((d) => d === q.done);
  const error = ERRORS.find((e) => e === q.error);
  const t = await getTranslations('network.savedSearches');
  const format = await getFormatter();
  const ref = sessionRef(session.user);
  const [saved, tax] = await Promise.all([fetchSavedSearches(ref), fetchTaxonomy(ref)]);
  if (saved === 'revoked' || tax === 'revoked') redirect('/session/expired');
  const names = listingTaxonomy(tax.ok ? tax.data : null);
  const euros = (cents: number) =>
    format.number(cents / 100, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const items = saved.ok ? saved.data.items : [];

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <Link href="/network" className="text-sm underline-offset-4 hover:underline">
          {t('toSearch')}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {done ? (
        <p role="status" className="text-sm text-green-700">
          {t(`done.${done}`)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${error}`, { max: SAVED_SEARCH_LIMITS.perUser })}
        </p>
      ) : null}

      {!saved.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.load')}
        </p>
      ) : items.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <ul className="flex flex-col gap-3" aria-label={t('listLabel')}>
          {items.map((s) => {
            const range =
              s.priceMinCents !== null || s.priceMaxCents !== null
                ? `${s.priceMinCents !== null ? euros(s.priceMinCents) : '…'} – ${s.priceMaxCents !== null ? euros(s.priceMaxCents) : '…'}`
                : null;
            const chips = [
              s.transactionType ? t(`transactions.${s.transactionType}`) : null,
              ...s.propertyTypeIds.map((id) => names.typeName(id)),
              ...s.locationIds.map((id) => names.locationName(id)),
              range,
              s.bedsMin !== null ? t('beds', { count: s.bedsMin }) : null,
            ].filter((x): x is string => Boolean(x));
            return (
              <li
                key={s.id}
                data-testid="saved-search"
                className="flex flex-wrap items-start gap-3 rounded-md border p-4 text-sm"
              >
                <div className="flex min-w-60 flex-1 flex-col gap-1">
                  <h2 className="font-medium">{s.name}</h2>
                  <p className="text-muted-foreground">{chips.length > 0 ? chips.join(' · ') : t('anything')}</p>
                  <p className="text-xs text-muted-foreground">
                    {[
                      t(`scopes.${s.scope}`),
                      t(`frequencies.${s.frequency}`),
                      s.alerts.map((k) => t(`alerts.${k}`)).join(', '),
                    ].join(' · ')}
                  </p>
                </div>
                <form action={deleteSavedSearchAction}>
                  <input type="hidden" name="id" value={s.id} />
                  <button type="submit" className="h-8 rounded-md border px-3">
                    {t('delete')}
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      )}

      <section aria-labelledby="saved-search-new" className="flex flex-col gap-3 rounded-md border p-4">
        <h2 id="saved-search-new" className="font-medium">
          {t('form.title')}
        </h2>
        <form action={createSavedSearchAction} className="grid gap-3 text-sm sm:grid-cols-2">
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span>{t('form.name')}</span>
            <input name="name" required maxLength={SAVED_SEARCH_LIMITS.nameChars} className={FIELD} />
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('form.transaction')}</span>
            <select name="transactionType" className={FIELD} defaultValue="">
              <option value="">{t('form.any')}</option>
              {TRANSACTION_TYPES.map((v) => (
                <option key={v} value={v}>
                  {t(`transactions.${v}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('form.propertyType')}</span>
            <select name="propertyTypeId" className={FIELD} defaultValue={prefill.type ?? ''}>
              <option value="">{t('form.any')}</option>
              {names.propertyTypes.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span>{t('form.location')}</span>
            <select name="locationId" className={FIELD} defaultValue={prefill.location ?? ''}>
              <option value="">{t('form.anywhere')}</option>
              {names.locations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('form.priceMin')}</span>
            <input name="priceMin" inputMode="numeric" defaultValue={prefill.min ?? ''} className={FIELD} />
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('form.priceMax')}</span>
            <input name="priceMax" inputMode="numeric" defaultValue={prefill.max ?? ''} className={FIELD} />
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('form.beds')}</span>
            <input name="beds" inputMode="numeric" defaultValue={prefill.beds ?? ''} className={FIELD} />
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('form.scope')}</span>
            <select name="scope" className={FIELD} defaultValue="ALL">
              {SAVED_SEARCH_SCOPES.map((v) => (
                <option key={v} value={v}>
                  {t(`scopes.${v}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('form.frequency')}</span>
            <select name="frequency" className={FIELD} defaultValue="INSTANT">
              {SAVED_SEARCH_FREQUENCIES.map((v) => (
                <option key={v} value={v}>
                  {t(`frequencies.${v}`)}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="flex flex-wrap gap-3 sm:col-span-2">
            <legend className="mb-1">{t('form.alerts')}</legend>
            {SAVED_SEARCH_ALERT_KINDS.map((k) => (
              <label key={k} className="flex items-center gap-1.5">
                <input type="checkbox" name="alerts" value={k} defaultChecked />
                {t(`alerts.${k}`)}
              </label>
            ))}
          </fieldset>
          <button type="submit" className="h-9 rounded-md border px-3 font-medium sm:col-span-2 sm:w-fit">
            {t('form.submit')}
          </button>
        </form>
      </section>
    </div>
  );
}
