import type { AgencySettingsDto } from '@inmolink/contracts';

/** The settings form's field values (strings as typed), from the API's settings or a refused submission. */
export interface SettingsValues {
  commissionType: 'NONE' | 'PCT' | 'FIXED';
  commissionPercent: string;
  commissionAmount: string;
  commissionCurrency: string;
  commissionIncludesVat: boolean;
  registrationValidityDays: string;
  viewingResponseDays: string;
  enabledLocales: string[];
  referencePrefix: string;
  showPoweredBy: boolean;
  emailSenderName: string;
  pinMinLength: string;
  pinMaxAttempts: string;
}

/**
 * A typed amount or percentage → integer hundredths (percent → basis points, amount → cents), or NaN
 * (refused by the contract: VALIDATION_FAILED). Unambiguous on purpose: digits, then optionally one
 * `.` or `,` and one or two decimals. No thousands separators — "5.000" (5,000 in Spanish, 5 in English)
 * and "5.000,50" are refused rather than guessed.
 */
export function parseHundredths(raw: string): number {
  const m = /^(\d{1,12})(?:[.,](\d{1,2}))?$/.exec(raw.trim());
  if (!m) return Number.NaN;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** Hundredths → "3.5" / "5000" (no locale grouping: it is an input value, parsed back by the action). */
const fromHundredths = (n: number) => String(n / 100);

export function settingsValues(s: AgencySettingsDto): SettingsValues {
  const c = s.defaultCommission;
  return {
    commissionType: c?.type ?? 'NONE',
    commissionPercent: c?.type === 'PCT' ? fromHundredths(c.basisPoints) : '',
    commissionAmount: c?.type === 'FIXED' ? fromHundredths(c.amount.amountCents) : '',
    commissionCurrency: c?.type === 'FIXED' ? c.amount.currency : '',
    commissionIncludesVat: c?.includesVat ?? false,
    registrationValidityDays: String(s.registrationValidityDays),
    viewingResponseDays: String(s.viewingResponseDays),
    enabledLocales: s.enabledLocales,
    referencePrefix: s.whiteLabel.referencePrefix ?? '',
    showPoweredBy: s.whiteLabel.showPoweredBy,
    emailSenderName: s.whiteLabel.emailSenderName ?? '',
    pinMinLength: String(s.clientMode.pinMinLength),
    pinMaxAttempts: String(s.clientMode.pinMaxAttempts),
  };
}
