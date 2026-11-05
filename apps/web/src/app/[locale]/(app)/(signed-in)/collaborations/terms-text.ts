import type { createFormatter } from 'next-intl';

/**
 * Commission terms as one line (S17-F56): the network search's sentences (`network.commission`) for a viewing's terms
 * snapshot and for a target before registering. Amounts come from the data, the formatters from the page.
 */
export interface TermsFacts {
  commissionBp: number | null;
  commissionFixed: { amountCents: number; currency: string } | null;
  splitBp: number | null;
  includesVat: boolean;
}

/** The page formatter's `number` (next-intl's own option types). */
export type NumberFormatter = Pick<ReturnType<typeof createFormatter>, 'number'>;

export interface TermsTools {
  t: (key: 'pct' | 'fixed' | 'vat' | 'none' | 'splitUnknown', values?: Record<string, string>) => string;
  money: (m: { amountCents: number; currency: string }) => string;
  percent: (bp: number) => string;
}

/** One amount, in the data's currency: whole euros stay whole, and cents are never rounded away. */
export function formatMoney(format: NumberFormatter, m: { amountCents: number; currency: string }): string {
  const digits = m.amountCents % 100 === 0 ? 0 : 2;
  return format.number(m.amountCents / 100, {
    style: 'currency',
    currency: m.currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** The tools every collaboration screen uses, so all three say the same amount. */
export function termsTools(format: NumberFormatter, t: TermsTools['t']): TermsTools {
  return {
    t,
    money: (m) => formatMoney(format, m),
    percent: (bp) => format.number(bp / 10_000, { style: 'percent', maximumFractionDigits: 2 }),
  };
}

export function termsText(terms: TermsFacts | null, { t, money, percent }: TermsTools): string {
  if (!terms) return t('none');
  const split = terms.splitBp === null ? t('splitUnknown') : percent(terms.splitBp);
  if (terms.commissionBp === null && !terms.commissionFixed) return t('none');
  const head =
    terms.commissionBp !== null
      ? t('pct', { total: percent(terms.commissionBp), split })
      : t('fixed', { amount: money(terms.commissionFixed as NonNullable<TermsFacts['commissionFixed']>), split });
  return terms.includesVat ? `${head} (${t('vat')})` : head;
}
