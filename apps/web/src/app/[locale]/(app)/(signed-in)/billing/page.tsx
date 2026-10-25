import type { CatalogItemDto, InvoiceDto } from '@inmolink/contracts';
import { Button, EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchBillingOverview, fetchInvoices } from '@/server/billing-api';
import { managePortalAction, subscribeAction } from './actions';
import { BILLING_NOTICE_ERRORS } from './errors';

const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;
/** Plan codes and payment methods with a translated name (`billing.planNames`, `billing.paymentMethods`); others show as sent. */
const PLAN_NAMES = ['free', 'pro', 'business', 'enterprise'] as const;
const PAYMENT_METHODS = ['card', 'sepa_debit'] as const;
/** Statuses during which the subscription is changed in the Customer Portal, not by a new checkout. */
const ENDED = new Set(['CANCELED', 'INCOMPLETE_EXPIRED']);

/**
 * Plan & billing (S13-01, PLAN §3 #28): the plan in force, the plans on offer (annual by default) with Stripe Checkout
 * (card or SEPA Direct Debit, VAT handled by Stripe Tax), the Customer Portal for changes and cancellation, and the
 * agency's invoices. Members see it; the API lets only admins check out or open the portal.
 */
export default async function BillingPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const params = await searchParams;
  const ref = sessionRef(session.user);
  const cursor = typeof params.cursor === 'string' && CURSOR.test(params.cursor) ? params.cursor : undefined;
  const overview = await fetchBillingOverview(ref);
  if (overview === 'revoked') redirect('/session/expired');
  // Invoices are the admins' (hosted links show the billing address and VAT ID): fetched only for them.
  const invoices = overview.ok && overview.data.canManage ? await fetchInvoices(ref, cursor) : null;
  if (invoices === 'revoked') redirect('/session/expired');
  const t = await getTranslations('billing');
  const format = await getFormatter();
  const money = (cents: number, currency: string) =>
    format.number(cents / 100, { style: 'currency', currency, minimumFractionDigits: cents % 100 ? 2 : 0 });
  const day = (iso: string | null) => (iso ? format.dateTime(new Date(iso), { dateStyle: 'medium' }) : '—');
  const planName = (code: string) => {
    const known = PLAN_NAMES.find((c) => c === code);
    return known ? t(`planNames.${known}`) : code;
  };
  const paymentMethod = (type: string) => {
    const known = PAYMENT_METHODS.find((c) => c === type);
    return known ? t(`paymentMethods.${known}`) : type;
  };
  const error =
    typeof params.error === 'string' ? (BILLING_NOTICE_ERRORS.find((c) => c === params.error) ?? 'generic') : null;

  if (!overview.ok) {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      </div>
    );
  }
  const { plan, seats, grant, graceEndsAt, subscription, hasCustomer, canManage, catalog } = overview.data;
  const canSubscribe = canManage && (!subscription || ENDED.has(subscription.status));
  const plans = catalog.filter((i: CatalogItemDto) => i.kind === 'PLAN' && i.prices.length > 0);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      {params.checkout === 'success' ? (
        <p role="status" className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-950">
          {t('notices.checkoutSuccess')}
        </p>
      ) : null}
      {params.checkout === 'cancelled' ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {t('notices.checkoutCancelled')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${error}`)}
        </p>
      ) : null}

      <section
        aria-labelledby="billing-current"
        className="flex flex-col gap-3 rounded-md border p-4"
        data-testid="billing-current"
      >
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="billing-current" className="font-medium">
            {t('current.title')}
          </h2>
          <span className="rounded bg-muted px-2 py-0.5 text-sm font-semibold">{planName(plan)}</span>
          {canManage && hasCustomer ? (
            <form action={managePortalAction} className="ml-auto">
              <Button type="submit" variant="outline" size="sm">
                {t('current.manage')}
              </Button>
            </form>
          ) : null}
        </div>
        {seats !== null ? (
          <p className="text-sm text-muted-foreground">{t('current.seats', { count: seats })}</p>
        ) : null}
        {graceEndsAt ? (
          <p role="alert" className="rounded-md border border-destructive/40 p-2 text-sm" data-testid="billing-grace">
            {t('current.graceEnds', { date: day(graceEndsAt) })}
          </p>
        ) : null}
        {grant ? (
          <p className="text-sm" data-testid="billing-grant">
            {t(grant.kind === 'TRIAL' ? 'current.trialEnds' : 'current.grantEnds', {
              plan: planName(grant.planCode),
              date: day(grant.endsAt),
            })}
          </p>
        ) : null}
        {subscription ? (
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{t('current.status')}</dt>
            <dd>{t(`statuses.${subscription.status}`)}</dd>
            {subscription.interval ? (
              <>
                <dt className="text-muted-foreground">{t('current.interval')}</dt>
                <dd>{t(`intervals.${subscription.interval}`)}</dd>
              </>
            ) : null}
            {subscription.paymentMethod ? (
              <>
                <dt className="text-muted-foreground">{t('current.paymentMethod')}</dt>
                <dd>{paymentMethod(subscription.paymentMethod)}</dd>
              </>
            ) : null}
            {subscription.cancelAt && !ENDED.has(subscription.status) ? (
              <>
                <dt className="text-muted-foreground">{t('current.endsOn')}</dt>
                <dd>{t('current.endsNote', { date: day(subscription.cancelAt) })}</dd>
              </>
            ) : subscription.currentPeriodEnd && !ENDED.has(subscription.status) ? (
              <>
                <dt className="text-muted-foreground">{t('current.renewsOn')}</dt>
                <dd>{day(subscription.currentPeriodEnd)}</dd>
              </>
            ) : null}
          </dl>
        ) : grant ? null : (
          <p className="text-sm text-muted-foreground">{t('current.free')}</p>
        )}
      </section>

      {canSubscribe ? (
        <section aria-labelledby="billing-plans" className="flex flex-col gap-3">
          <h2 id="billing-plans" className="font-medium">
            {t('plans.title')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('plans.vatNote')}</p>
          {plans.length === 0 ? (
            <EmptyState title={t('plans.empty')} />
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2" data-testid="billing-plans">
              {plans.map((item: CatalogItemDto) => {
                return (
                  <li key={item.code} className="flex flex-col gap-3 rounded-md border p-4">
                    <div className="flex items-baseline gap-2">
                      <span className="text-lg font-semibold">{planName(item.code)}</span>
                      {item.seatsIncluded ? (
                        <span className="text-sm text-muted-foreground">
                          {t('plans.seats', { count: item.seatsIncluded })}
                        </span>
                      ) : null}
                    </div>
                    <form action={subscribeAction} className="flex flex-col gap-2 text-sm">
                      <input type="hidden" name="planCode" value={item.code} />
                      <fieldset className="flex flex-col gap-1">
                        <legend className="sr-only">{t('plans.interval')}</legend>
                        {/* One choice per period and currency: the price shown is the price charged. Annual EUR first. */}
                        {[...item.prices]
                          .sort(
                            (x, y) =>
                              Number(y.currency === 'EUR') - Number(x.currency === 'EUR') ||
                              Number(y.interval === 'YEAR') - Number(x.interval === 'YEAR'),
                          )
                          .map((p, i) => (
                            <label key={`${p.interval}:${p.currency}`} className="flex items-center gap-2">
                              <input
                                type="radio"
                                name="price"
                                value={`${p.interval}:${p.currency}`}
                                defaultChecked={i === 0}
                              />
                              <span>
                                {money(p.amountCents, p.currency)} {t(`per.${p.interval}`)}
                              </span>
                            </label>
                          ))}
                      </fieldset>
                      <Button type="submit" size="sm" className="self-start">
                        {t('plans.subscribe')}
                      </Button>
                    </form>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">{t('plans.paymentNote')}</p>
        </section>
      ) : null}

      {invoices ? (
        <section aria-labelledby="billing-invoices" className="flex flex-col gap-3">
          <h2 id="billing-invoices" className="font-medium">
            {t('invoices.title')}
          </h2>
          {!invoices.ok ? (
            <p role="alert" className="text-sm text-destructive">
              {t('errors.generic')}
            </p>
          ) : invoices.data.items.length === 0 ? (
            <EmptyState title={t('invoices.empty')} />
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-left text-sm" data-testid="billing-invoices">
                <thead className="bg-muted">
                  <tr>
                    <th className="p-2">{t('invoices.columns.number')}</th>
                    <th className="p-2">{t('invoices.columns.date')}</th>
                    <th className="p-2">{t('invoices.columns.status')}</th>
                    <th className="p-2 text-right">{t('invoices.columns.total')}</th>
                    <th className="p-2">
                      <span className="sr-only">{t('invoices.columns.links')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {invoices.data.items.map((inv: InvoiceDto) => (
                    <tr key={inv.id}>
                      <td className="p-2">{inv.number ?? '—'}</td>
                      <td className="p-2 whitespace-nowrap">{day(inv.issuedAt)}</td>
                      <td className="p-2">{t(`invoiceStatuses.${inv.status}`)}</td>
                      <td className="p-2 text-right whitespace-nowrap">
                        {money(inv.totalCents, inv.currency)}
                        {inv.taxCents ? (
                          <span className="block text-xs text-muted-foreground">
                            {t('invoices.tax', { amount: money(inv.taxCents, inv.currency) })}
                          </span>
                        ) : null}
                      </td>
                      <td className="p-2 whitespace-nowrap">
                        {inv.hostedUrl ? (
                          <a
                            href={inv.hostedUrl}
                            rel="noopener noreferrer"
                            target="_blank"
                            className="underline-offset-4 hover:underline"
                          >
                            {t('invoices.view')}
                          </a>
                        ) : null}
                        {inv.pdfUrl ? (
                          <a
                            href={inv.pdfUrl}
                            rel="noopener noreferrer"
                            target="_blank"
                            className="ml-3 underline-offset-4 hover:underline"
                          >
                            {t('invoices.pdf')}
                          </a>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {invoices.ok && invoices.data.nextCursor ? (
            <Link
              href={{ pathname: '/billing', query: { cursor: invoices.data.nextCursor } }}
              className="text-sm font-medium underline-offset-4 hover:underline"
            >
              {t('next')}
            </Link>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
