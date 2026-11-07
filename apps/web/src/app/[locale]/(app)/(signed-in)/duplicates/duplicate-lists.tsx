import type { DedupeClusterDto, DedupeListingCard, DedupeReviewDto } from '@inmolink/contracts';
import { DEDUPE_DISPUTE_KINDS } from '@inmolink/contracts';
import { EmptyState } from '@inmolink/ui';
import { Link } from '@/i18n/navigation';

/**
 * The duplicate pages' lists (R2-03b): the review queue — the agency's listing next to the likely duplicate (as far as
 * the caller may see it; another agency is never named), the score and its signals, and the two decisions — and the
 * grouped listings — the group's members the caller may see in the order clients are shown them, whether its own
 * listing is the one shown, and a dispute form. Plain forms, no client JS.
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;
type FormAction = string | ((form: FormData) => void | Promise<void>);

interface Shared {
  /** `listings.duplicates` messages. */
  t: Translate;
  money: (amountCents: number, currency: string) => string;
  percent: (fraction: number) => string;
  /** The page's own query, carried by the forms so the member returns to the same view. */
  back: Record<string, string>;
  /** Older items follow (a page can come back empty when its listings may not be shown). */
  more?: boolean;
}

const SIGNALS = ['images', 'phash', 'geo', 'type', 'beds', 'baths', 'area', 'price', 'text'] as const;

function Card({ card, label, t, money }: { card: DedupeListingCard; label: string } & Pick<Shared, 't' | 'money'>) {
  const price =
    card.price.onRequest || card.price.amountCents === null
      ? t('priceOnRequest')
      : money(card.price.amountCents, card.price.currency);
  const place = [card.place.area, card.place.city].flatMap((x) => (x ? [x.name] : [])).join(', ');
  return (
    <div className="min-w-0 flex-1 rounded-md bg-muted/40 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium">
        <Link href={`/listings/${card.id}`} className="underline-offset-4 hover:underline">
          {card.title}
        </Link>
      </p>
      <p className="text-xs text-muted-foreground">
        {[card.ref, place, card.propertyType.name, price].filter(Boolean).join(' · ')}
      </p>
    </div>
  );
}

const Back = ({ back }: { back: Record<string, string> }) =>
  Object.entries(back).map(([k, v]) => <input key={k} type="hidden" name={`back.${k}`} value={v} />);

export function ReviewList({
  items,
  status,
  t,
  money,
  percent,
  back,
  decide,
  more = false,
}: Shared & { items: DedupeReviewDto[]; status: DedupeReviewDto['status']; decide: FormAction }) {
  if (items.length === 0) {
    if (more) return <p className="text-sm text-muted-foreground">{t('pageHidden')}</p>;
    return <EmptyState title={status === 'PENDING' ? t('empty') : t('emptyDecided')} />;
  }
  return (
    <ul className="flex flex-col gap-3" aria-label={t('listLabel')}>
      {items.map((r) => (
        <li key={r.id} data-testid="duplicate-review" className="flex flex-col gap-3 rounded-md border p-4 text-sm">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Card card={r.listing} label={t('yours')} t={t} money={money} />
            <Card card={r.other.card} label={r.other.network ? t('network') : t('own')} t={t} money={money} />
          </div>
          <p className="flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-muted px-2 py-0.5 font-medium">{t('score', { pct: percent(r.score) })}</span>
            <span className="text-xs text-muted-foreground">{t('signalsLabel')}:</span>
            {SIGNALS.flatMap((s) => {
              const v = r.signals[s];
              return v === null ? [] : [{ s, v }];
            }).map(({ s, v }) => (
              <span key={s} className="rounded-full border px-2 py-0.5 text-xs">
                {t(`signals.${s}`)} {percent(v)}
              </span>
            ))}
          </p>
          {r.status === 'PENDING' ? (
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap gap-2">
                {(['confirm', 'not-duplicate'] as const).map((mv) => (
                  <form key={mv} action={decide}>
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="move" value={mv} />
                    <Back back={back} />
                    <button
                      type="submit"
                      aria-label={t(mv === 'confirm' ? 'confirmLabel' : 'notDuplicateLabel', {
                        ref: r.listing.ref,
                        other: r.other.card.ref,
                      })}
                      className={
                        mv === 'confirm'
                          ? 'h-8 rounded-md border bg-primary px-3 text-primary-foreground'
                          : 'h-8 rounded-md border px-3'
                      }
                    >
                      {t(mv === 'confirm' ? 'confirm' : 'notDuplicate')}
                    </button>
                  </form>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{t('notDuplicateHint')}</p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t(`statuses.${r.status}`)}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ClusterList({
  items,
  t,
  money,
  back,
  dispute,
  more = false,
}: Omit<Shared, 'percent'> & { items: DedupeClusterDto[]; dispute: FormAction }) {
  if (items.length === 0) {
    if (more) return <p className="text-sm text-muted-foreground">{t('pageHidden')}</p>;
    return <EmptyState title={t('emptyClusters')} />;
  }
  return (
    <ul className="flex flex-col gap-3" aria-label={t('clustersLabel')}>
      {items.map((c) => (
        <li
          key={c.listingId}
          data-testid="duplicate-cluster"
          className="flex flex-col gap-3 rounded-md border p-4 text-sm"
        >
          <p className="font-medium">
            {c.canonical ? t('canonical') : t('notCanonical')}{' '}
            <span className="text-xs font-normal text-muted-foreground">· {t(`via.${c.via}`)}</span>
          </p>
          <ol className="flex flex-col gap-2">
            {c.members.map((m) => (
              <li key={m.card.id}>
                <Card
                  card={m.card}
                  label={m.card.id === c.listingId ? t('yours') : m.network ? t('network') : t('own')}
                  t={t}
                  money={money}
                />
              </li>
            ))}
          </ol>
          {c.openDispute ? (
            <p role="status" className="text-xs">
              {t('dispute.open', { kind: t(`dispute.kinds.${c.openDispute.kind}`) })}
            </p>
          ) : (
            <details>
              <summary className="cursor-pointer text-sm font-medium">{t('dispute.title')}</summary>
              <form action={dispute} className="mt-2 flex flex-col gap-2">
                <input type="hidden" name="listingId" value={c.listingId} />
                <Back back={back} />
                <fieldset className="flex flex-col gap-1">
                  <legend className="text-xs text-muted-foreground">{t('dispute.kind')}</legend>
                  {DEDUPE_DISPUTE_KINDS.filter((k) => k !== 'CANONICAL' || !c.canonical).map((k, i) => (
                    <label key={k} className="flex items-center gap-2">
                      <input type="radio" name="kind" value={k} defaultChecked={i === 0} />
                      {t(`dispute.kinds.${k}`)}
                    </label>
                  ))}
                </fieldset>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">{t('dispute.reason')}</span>
                  <textarea name="reason" required maxLength={1000} rows={3} className="rounded-md border p-2" />
                </label>
                <p className="text-xs text-muted-foreground">{t('dispute.hint')}</p>
                <button type="submit" className="h-8 self-start rounded-md border px-3">
                  {t('dispute.submit')}
                </button>
              </form>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}
