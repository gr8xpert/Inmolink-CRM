import type { DealDto, TargetLabel } from '@inmolink/contracts';
import { handshake, timelineSteps } from './query';

/**
 * The deal room's read-only parts (R2-04c): the stage timeline, the commission breakdown from the terms snapshot and
 * the handshake. Every amount is the API's (the database computes the commission in generated columns); these only
 * format it. Server-rendered, no client JS.
 */

export type Translate = (key: string, values?: Record<string, string | number>) => string;

export interface Formatters {
  /** `network.deals` messages. */
  t: Translate;
  money: (amountCents: number, currency: string) => string;
  percent: (basisPoints: number) => string;
  date: (iso: string) => string;
}

export function targetText(t: Translate, d: { target: DealDto['target']; targetLabel: TargetLabel | null }): string {
  const kind = t(`kinds.${d.target.kind}`);
  return d.targetLabel
    ? `${kind} ${d.targetLabel.reference}${d.targetLabel.title ? ` · ${d.targetLabel.title}` : ''}`
    : `${kind} ${d.target.id.slice(0, 8)}`;
}

const STEP_CLASS = {
  done: 'border-primary bg-primary text-primary-foreground',
  current: 'border-primary font-semibold',
  next: 'border-dashed text-muted-foreground',
  skipped: 'border-dashed text-muted-foreground line-through',
} as const;

export function StageTimeline({ deal, t, date }: { deal: DealDto } & Pick<Formatters, 't' | 'date'>) {
  const steps = timelineSteps(deal);
  return (
    <div className="flex flex-col gap-2">
      <ol aria-label={t('timeline.label')} className="flex flex-wrap gap-2 text-sm" data-testid="deal-timeline">
        {steps.map((s) => (
          <li
            key={s.stage}
            aria-current={s.state === 'current' ? 'step' : undefined}
            data-state={s.state}
            className={`rounded-full border px-3 py-1 ${STEP_CLASS[s.state]}`}
          >
            <span className="sr-only">{t(`timeline.states.${s.state}`)}: </span>
            {t(`stages.${s.stage}`)}
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">
        {t('timeline.since', { stage: t(`stages.${deal.stage}`), date: date(deal.stageAt) })}
      </p>
      {deal.stage === 'FELL_THROUGH' && deal.fellThroughReason ? (
        <p className="text-sm" data-testid="deal-fell-through">
          {t('timeline.fellThrough', { by: t(`closedBy.${deal.closedBy ?? 'STAFF'}`) })}: {deal.fellThroughReason}
        </p>
      ) : null}
      {deal.mediatedAt && deal.mediationReason ? (
        <p className="rounded-md bg-muted p-2 text-sm" data-testid="deal-mediation">
          {t('timeline.mediated', { date: date(deal.mediatedAt) })}: {deal.mediationReason}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The commission of the current price as the snapshot says: the rate (or the fixed amount), the split, VAT, and the
 * three amounts — the caller's own share named as such.
 */
export function CommissionBreakdown({ deal, t, money, percent, date }: { deal: DealDto } & Formatters) {
  const c = deal.commission;
  const terms = deal.terms;
  const rate = terms.commissionFixed
    ? t('commission.fixed', { amount: money(terms.commissionFixed.amountCents, terms.commissionFixed.currency) })
    : t('commission.rate', { rate: percent(terms.commissionBp ?? 0) });
  const mine = deal.party === 'OWNER' ? 'owner' : 'introducer';
  const row = (key: 'total' | 'introducer' | 'owner', cents: number) => (
    <div
      className={`flex justify-between gap-4 ${key === mine ? 'font-semibold' : ''}`}
      data-testid={`commission-${key}`}
    >
      <dt>
        {t(`commission.${key}`)}
        {key === mine ? ` (${t('commission.yours')})` : ''}
      </dt>
      <dd className="tabular-nums">{money(cents, c.currency)}</dd>
    </div>
  );
  return (
    <div className="flex flex-col gap-2 text-sm">
      <dl className="flex flex-col gap-1">
        <div className="flex justify-between gap-4">
          <dt>{t('price.label')}</dt>
          <dd className="tabular-nums font-medium" data-testid="deal-price">
            {money(deal.price.amountCents, deal.price.currency)}
          </dd>
        </div>
        {row('total', c.totalCents)}
        {row('introducer', c.introducerShareCents)}
        {row('owner', c.ownerShareCents)}
      </dl>
      <p className="text-xs text-muted-foreground">
        {rate} · {t('commission.split', { split: percent(terms.splitBp) })} ·{' '}
        {t(terms.includesVat ? 'commission.vatIncluded' : 'commission.vatExcluded')} ·{' '}
        {t('commission.snapshot', { date: date(terms.snapshotAt) })}
      </p>
    </div>
  );
}

export function Handshake({ deal, t, date }: { deal: DealDto } & Pick<Formatters, 't' | 'date'>) {
  const h = handshake(deal);
  const side = (who: 'mine' | 'theirs', at: string | null) => (
    <li data-testid={`handshake-${who}`}>
      {t(`handshake.${who}`)}: {at ? t('handshake.confirmedAt', { date: date(at) }) : t('handshake.pending')}
    </li>
  );
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {side('mine', h.mine)}
      {side('theirs', h.theirs)}
    </ul>
  );
}
