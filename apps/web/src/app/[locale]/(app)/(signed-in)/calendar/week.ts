import { zonedToUtc } from '../tasks/time';

/**
 * Week arithmetic for the calendar page (S10-06): weeks run Monday to Sunday in the platform time zone
 * (`DEFAULT_TIME_ZONE`), not the server's. A week is named by its Monday (`2026-10-19`).
 */

export interface CalendarDay {
  /** `YYYY-MM-DD` (local). */
  key: string;
  start: Date;
  end: Date;
}

export interface CalendarWeek {
  key: string;
  prev: string;
  next: string;
  days: CalendarDay[];
  start: Date;
  end: Date;
}

const WEEK_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n: number) => String(n).padStart(2, '0');
const keyOf = (utcMidnight: Date) =>
  `${utcMidnight.getUTCFullYear()}-${pad(utcMidnight.getUTCMonth() + 1)}-${pad(utcMidnight.getUTCDate())}`;

/** The local calendar date of `at` in `timeZone`, as a UTC midnight (only its fields are used). */
function localDate(at: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return new Date(Date.UTC(n('year'), n('month') - 1, n('day')));
}

/** A valid `YYYY-MM-DD` as a UTC midnight, or null. */
function parseKey(value: string | undefined): Date | null {
  const m = value ? WEEK_KEY.exec(value) : null;
  if (!m) return null;
  const [y, mo, d] = m.slice(1).map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return y >= 2000 && y < 9000 ? date : null;
}

const plusDays = (date: Date, days: number) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));

/** The week containing `param` (any day of it), else the week of `now`; its seven days' bounds in `timeZone`. */
export function weekOf(param: string | undefined, now: Date, timeZone: string): CalendarWeek {
  const base = parseKey(param) ?? localDate(now, timeZone);
  const monday = plusDays(base, -((base.getUTCDay() + 6) % 7));
  const startOf = (d: Date) =>
    zonedToUtc({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }, timeZone);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = plusDays(monday, i);
    return { key: keyOf(d), start: startOf(d), end: startOf(plusDays(d, 1)) };
  });
  return {
    key: keyOf(monday),
    prev: keyOf(plusDays(monday, -7)),
    next: keyOf(plusDays(monday, 7)),
    days,
    start: (days[0] as CalendarDay).start,
    end: (days[6] as CalendarDay).end,
  };
}

/** The local day (`YYYY-MM-DD`) an instant falls on. */
export function dayKey(at: Date, timeZone: string): string {
  return keyOf(localDate(at, timeZone));
}
