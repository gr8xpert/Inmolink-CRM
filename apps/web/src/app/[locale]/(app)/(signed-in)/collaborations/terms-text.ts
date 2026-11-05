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

export interface TermsTools {
  t: (key: 'pct' | 'fixed' | 'vat' | 'none' | 'splitUnknown', values?: Record<string, string>) => string;
  money: (m: { amountCents: number; currency: string }) => string;
  percent: (bp: number) => string;
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
