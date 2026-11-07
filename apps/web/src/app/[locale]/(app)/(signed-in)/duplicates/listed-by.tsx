import type { DedupeListedBy, NetworkCommission } from '@inmolink/contracts';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';

/**
 * "Listed by N agencies" (R2-03c, PLAN §10): the members of a listing's duplicate cluster the agent may see — its own
 * listing, other agencies' network listings with their agency and commission terms — in canonical order, the first
 * marked as the one shown to clients. Server component; the data comes from `GET /v1/duplicates/listed-by` (the
 * service decides what may be seen). `compact`: a one-line summary for a search result.
 */
export async function ListedByPanel(props: { item: DedupeListedBy; currentId: string; compact?: boolean }) {
  const { item, currentId } = props;
  const t = await getTranslations('listings');
  const format = await getFormatter();
  const money = (m: { amountCents: number; currency: string }) =>
    format.number(m.amountCents / 100, { style: 'currency', currency: m.currency, maximumFractionDigits: 0 });
  const percent = (bp: number) => format.number(bp / 10_000, { style: 'percent', maximumFractionDigits: 2 });
  const commission = (c: NetworkCommission | null): string => {
    if (!c) return t('duplicates.listedBy.noCommission');
    const split = c.splitBp === null ? t('duplicates.listedBy.splitUnknown') : percent(c.splitBp);
    const head =
      c.type === 'PCT' && c.totalBp !== null
        ? t('duplicates.listedBy.commissionPct', { total: percent(c.totalBp), split })
        : c.fixed
          ? t('duplicates.listedBy.commissionFixed', { amount: money(c.fixed), split })
          : t('duplicates.listedBy.noCommission');
    return c.viewerEarnings ? `${head} · ${t('duplicates.listedBy.earn', { amount: money(c.viewerEarnings) })}` : head;
  };
  const title = t('duplicates.listedBy.title', { count: item.agencies });
  if (props.compact) {
    return <p className="rounded bg-muted px-2 py-1 text-xs">{title}</p>;
  }
  return (
    <section aria-label={t('duplicates.listedBy.label')} className="flex flex-col gap-2 rounded-md border p-4">
      <h2 className="font-medium">{title}</h2>
      <ul className="flex flex-col gap-2 text-sm">
        {item.members.map((m) => (
          <li key={m.listingId} className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="min-w-0">
              {m.listingId === currentId ? (
                <span className="font-medium">{m.reference}</span>
              ) : (
                <Link href={`/listings/${m.listingId}`} className="font-medium underline-offset-4 hover:underline">
                  {m.reference}
                </Link>
              )}
              <span className="ml-2 text-muted-foreground">
                {m.own || !m.agency
                  ? t('duplicates.listedBy.yours')
                  : t('duplicates.listedBy.agency', { name: m.agency.name })}
              </span>
              {m.canonical ? (
                <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">
                  {t('duplicates.listedBy.canonical')}
                </span>
              ) : null}
            </span>
            <span className="flex flex-col items-end">
              <span className="font-semibold">
                {m.price.onRequest || m.price.amountCents === null
                  ? t('duplicates.listedBy.priceOnRequest')
                  : money({ amountCents: m.price.amountCents, currency: m.price.currency })}
              </span>
              {m.own ? null : <span className="text-xs text-muted-foreground">{commission(m.commission)}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
