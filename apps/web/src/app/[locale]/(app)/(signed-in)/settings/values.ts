import type { AgencySettingsDto } from '@inmolink/contracts';

/** The settings form's field values (strings as typed), from the API's settings or a refused submission. */
export interface SettingsValues {
  commissionType: 'PCT' | 'FIXED';
  commissionPercent: string;
  commissionAmount: string;
  commissionCurrency: string;
  commissionIncludesVat: boolean;
  splitPercent: string;
  registrationValidityDays: string;
  viewingResponseDays: string;
  enabledLocales: string[];
  timeZone: string;
  referencePrefix: string;
  showPoweredBy: boolean;
  emailSenderName: string;
  pinMinLength: string;
  pinMaxAttempts: string;
}

/** The zones the settings form offers: Spain's three (the peninsula, Ceuta and Melilla, the Canary Islands) first. */
export const TIME_ZONES = [
  'Europe/Madrid',
  'Atlantic/Canary',
  'Africa/Ceuta',
  'Europe/Lisbon',
  'Atlantic/Madeira',
  'Atlantic/Azores',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Brussels',
  'Europe/Amsterdam',
  'Europe/Berlin',
  'Europe/Zurich',
  'Europe/Vienna',
  'Europe/Rome',
  'Europe/Copenhagen',
  'Europe/Oslo',
  'Europe/Stockholm',
  'Europe/Helsinki',
  'Europe/Athens',
  'UTC',
] as const;

/** The options of the zone select: the list, plus the agency's current zone when it is not in it. */
export const timeZoneOptions = (current: string): string[] =>
  (TIME_ZONES as readonly string[]).includes(current) ? [...TIME_ZONES] : [current, ...TIME_ZONES];

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
    commissionType: c.type,
    commissionPercent: c.type === 'PCT' ? fromHundredths(c.basisPoints) : '',
    commissionAmount: c.type === 'FIXED' ? fromHundredths(c.amount.amountCents) : '',
    commissionCurrency: c.type === 'FIXED' ? c.amount.currency : '',
    commissionIncludesVat: c.includesVat,
    splitPercent: fromHundredths(s.defaultSplitBp),
    registrationValidityDays: String(s.registrationValidityDays),
    viewingResponseDays: String(s.viewingResponseDays),
    enabledLocales: s.enabledLocales,
    timeZone: s.timeZone,
    referencePrefix: s.whiteLabel.referencePrefix ?? '',
    showPoweredBy: s.whiteLabel.showPoweredBy,
    emailSenderName: s.whiteLabel.emailSenderName ?? '',
    pinMinLength: String(s.clientMode.pinMinLength),
    pinMaxAttempts: String(s.clientMode.pinMaxAttempts),
  };
}
