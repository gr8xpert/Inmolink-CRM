import { DEAL_STAGES } from '@inmolink/contracts';
import { EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { ClientModeUnavailable } from '@/components/shell/client-mode-unavailable';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchDeals } from '@/server/deals-api';
import { inClientMode } from '@/server/nav';
import { loadShell } from '@/server/shell';
import { targetText } from './deal-parts';
import { parseDealsState } from './query';

/**
 * The deal room's list (R2-04c, PLAN §3 #10): the agency's deals as owner and as introducer, newest first, by stage,
 * with the price and the agency's own share of the commission. Server-rendered, no client JS; "show more" by cursor.
 */
export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const shell = await loadShell();
  if (shell && inClientMode(shell.identity)) return <ClientModeUnavailable />;
  const state = parseDealsState(await searchParams);
  const res = await fetchDeals(sessionRef(session.user), state);
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('network.deals');
  const format = await getFormatter();
  const tr = (key: string, values?: Record<string, string | number>) => t(key as never, values as never);
  const money = (cents: number, currency: string) =>
    format.number(cents / 100, { style: 'currency', currency, maximumFractionDigits: 2 });
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });
  const pill = (active: boolean) =>
    active
      ? 'rounded-md border bg-muted px-3 py-1 font-medium'
      : 'rounded-md border px-3 py-1 underline-offset-4 hover:underline';

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <nav aria-label={t('stageFilter')} className="flex flex-wrap items-center gap-2 text-sm">
        <Link href="/deals" aria-current={state.stage ? undefined : 'true'} className={pill(!state.stage)}>
          {t('allStages')}
        </Link>
        {DEAL_STAGES.map((s) => (
          <Link
            key={s}
            href={{ pathname: '/deals', query: { stage: s } }}
            aria-current={state.stage === s ? 'true' : undefined}
            className={pill(state.stage === s)}
          >
            {t(`stages.${s}`)}
          </Link>
        ))}
      </nav>

      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {res.error?.code === 'FORBIDDEN' ? t('errors.FORBIDDEN') : t('errors.load')}
        </p>
      ) : res.data.items.length === 0 ? (
        <EmptyState title={t('empty')} description={t('emptyHint')} />
      ) : (
        <ul className="divide-y rounded-md border" data-testid="deal-list">
          {res.data.items.map((d) => {
            const share = d.party === 'OWNER' ? d.commission.ownerShareCents : d.commission.introducerShareCents;
            return (
              <li key={d.id} className="flex flex-col gap-1 p-3 text-sm">
                <Link href={`/deals/${d.id}`} className="font-medium underline-offset-4 hover:underline">
                  {targetText(tr, d)}
                </Link>
                <p className="text-muted-foreground">
                  {[
                    t(`stages.${d.stage}`),
                    t(`parties.${d.party}`),
                    d.counterpartName ?? t('unknownAgency'),
                    money(d.price.amountCents, d.price.currency),
                    t('list.share', { amount: money(share, d.commission.currency) }),
                    date(d.createdAt),
                  ].join(' · ')}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {res.ok && res.data.nextCursor ? (
        <Link
          href={{
            pathname: '/deals',
            query: { ...(state.stage ? { stage: state.stage } : {}), cursor: res.data.nextCursor },
          }}
          className="self-start text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('loadMore')}
        </Link>
      ) : null}
    </div>
  );
}
