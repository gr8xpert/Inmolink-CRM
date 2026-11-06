import type { ClientProfileMatchDto } from '@inmolink/contracts';
import { EmptyState } from '@inmolink/ui';
import { Link } from '@/i18n/navigation';

/**
 * The review queue's list (R2-02d): each match's listing card (from the read model: title, reference, price, place,
 * facts), the client it is for, the score, the explanation as chips (met / not met, with a text marker as well as
 * colour), and its moves — approve or dismiss a pending one, restore a dismissed one — as plain forms (no client JS).
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;
type FormAction = string | ((form: FormData) => void | Promise<void>);

export interface MatchListProps {
  items: ClientProfileMatchDto[];
  status: 'PENDING_REVIEW' | 'DISMISSED';
  /** `contacts.matchQueue` messages. */
  t: Translate;
  money: (amountCents: number, currency: string) => string;
  number: (n: number) => string;
  percent: (fraction: number) => string;
  /** The page's own query (filter, status), carried by the move forms so the member returns to the same view. */
  back: Record<string, string>;
  move: FormAction;
  /** Older matches follow (a page can come back empty when its listings can no longer be offered). */
  more?: boolean;
}

const nameOf = (c: ClientProfileMatchDto['contact']) => [c.firstName, c.lastName].filter(Boolean).join(' ') || null;

export function MatchList({ items, status, t, money, number, percent, back, move, more = false }: MatchListProps) {
  if (items.length === 0) {
    if (more) return <p className="text-sm text-muted-foreground">{t('pageHidden')}</p>;
    return <EmptyState title={status === 'DISMISSED' ? t('emptyDismissed') : t('empty')} />;
  }
  return (
    <ul className="flex flex-col gap-3" aria-label={t('listLabel')}>
      {items.map((m) => {
        const c = m.card;
        const name = nameOf(m.contact) ?? t('noName');
        const price =
          c.price.onRequest || c.price.amountCents === null
            ? t('priceOnRequest')
            : money(c.price.amountCents, c.price.currency);
        const place = [c.place.area, c.place.city, c.place.region].flatMap((x) => (x ? [x.name] : [])).join(', ');
        const facts = [
          c.propertyType.name,
          c.bedrooms === null ? null : t('beds', { count: c.bedrooms }),
          c.builtM2 === null ? null : t('m2', { value: number(c.builtM2) }),
        ].filter((x): x is string => Boolean(x));
        const moves =
          m.status === 'PENDING_REVIEW'
            ? (['approve', 'dismiss'] as const)
            : m.status === 'DISMISSED'
              ? (['restore'] as const)
              : [];
        return (
          <li key={m.id} data-testid="profile-match" className="flex flex-col gap-3 rounded-md border p-4 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="font-medium">
                  <Link href={`/listings/${c.id}`} className="underline-offset-4 hover:underline">
                    {c.title}
                  </Link>
                </h2>
                <p className="text-xs text-muted-foreground">
                  {c.ref} · {m.network ? t('network') : t('own')}
                </p>
              </div>
              <p className="shrink-0 font-semibold">{price}</p>
            </div>
            <p>{[place, ...facts].filter(Boolean).join(' · ')}</p>
            <p className="flex flex-wrap items-center gap-2">
              <span>
                {t('forContact', { name })} ·{' '}
                <Link href={`/contacts/${m.contact.id}`} className="underline-offset-4 hover:underline">
                  {t('contactLink')}
                </Link>
              </span>
              <span className="rounded-md bg-muted px-2 py-0.5 font-medium">
                {t('score', { pct: percent(m.score) })}
              </span>
            </p>
            <div className="flex flex-col gap-1">
              <p className="text-xs text-muted-foreground">
                {t('reasonsLabel')}: {m.explanation.summary}
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {m.explanation.reasons.map((r) => (
                  <li
                    // a reason's key and text are unique within its match
                    key={`${r.key}:${r.text}`}
                    className={
                      r.ok
                        ? 'rounded-full border border-green-700 px-2 py-0.5 text-green-800 dark:text-green-300'
                        : 'rounded-full border border-amber-700 px-2 py-0.5 text-amber-900 dark:text-amber-300'
                    }
                  >
                    <span aria-hidden="true">{r.ok ? '✓ ' : '✗ '}</span>
                    <span className="sr-only">{r.ok ? t('met') : t('notMet')}: </span>
                    {r.text}
                  </li>
                ))}
              </ul>
            </div>
            {moves.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {moves.map((mv) => (
                  <form key={mv} action={move}>
                    <input type="hidden" name="id" value={m.id} />
                    <input type="hidden" name="move" value={mv} />
                    {Object.entries(back).map(([k, v]) => (
                      <input key={k} type="hidden" name={`back.${k}`} value={v} />
                    ))}
                    <button
                      type="submit"
                      aria-label={t(`${mv}Label`, { title: c.title, name })}
                      className={
                        mv === 'approve'
                          ? 'h-8 rounded-md border bg-primary px-3 text-primary-foreground'
                          : 'h-8 rounded-md border px-3'
                      }
                    >
                      {t(mv)}
                    </button>
                  </form>
                ))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
