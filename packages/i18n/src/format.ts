import { DEFAULT_TIME_ZONE } from './locales';

/**
 * Locale formatters for code outside React (emails, PDFs, exports). Components use next-intl's
 * `useFormatter()` / `getFormatter()` — same `Intl` underneath. Never hard-code formats or currencies:
 * money is stored as integer cents plus an ISO currency code.
 */
export interface Formatter {
  locale: string;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  /** `money(450_000_00, 'EUR')` → "450.000 €" (es) / "€450,000" (en). Whole units unless cents exist. */
  money(amountCents: number, currency: string): string;
  /** Square metres: "120 m²". */
  area(squareMetres: number): string;
  date(value: Date, options?: Intl.DateTimeFormatOptions): string;
  dateTime(value: Date, options?: Intl.DateTimeFormatOptions): string;
  /** "3 days ago" / "hace 3 días", picking the largest sensible unit. */
  relative(value: Date, now?: Date): string;
}

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat>();

function cached<T extends Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat>(
  key: string,
  make: () => T,
): T {
  let f = cache.get(key) as T | undefined;
  if (!f) {
    f = make();
    if (cache.size > 500) cache.clear();
    cache.set(key, f);
  }
  return f;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
];

export function formatter(locale: string, timeZone: string = DEFAULT_TIME_ZONE): Formatter {
  const num = (options?: Intl.NumberFormatOptions) =>
    cached(`n|${locale}|${JSON.stringify(options ?? {})}`, () => new Intl.NumberFormat(locale, options));
  const dt = (options: Intl.DateTimeFormatOptions) =>
    cached(
      `d|${locale}|${timeZone}|${JSON.stringify(options)}`,
      () => new Intl.DateTimeFormat(locale, { ...options, timeZone }),
    );
  return {
    locale,
    number: (value, options) => num(options).format(value),
    money: (amountCents, currency) => {
      const whole = amountCents % 100 === 0;
      return num({
        style: 'currency',
        currency,
        minimumFractionDigits: whole ? 0 : 2,
        maximumFractionDigits: whole ? 0 : 2,
      }).format(amountCents / 100);
    },
    area: (squareMetres) => `${num({ maximumFractionDigits: 2 }).format(squareMetres)} m²`,
    date: (value, options = { dateStyle: 'medium' }) => dt(options).format(value),
    dateTime: (value, options = { dateStyle: 'medium', timeStyle: 'short' }) => dt(options).format(value),
    relative: (value, now = new Date()) => {
      const seconds = Math.round((value.getTime() - now.getTime()) / 1000);
      const [unit, size] = UNITS.find(([, s]) => Math.abs(seconds) >= s) ?? ['second', 1];
      const rtf = cached(`r|${locale}`, () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }));
      return rtf.format(Math.round(seconds / size), unit);
    },
  };
}
