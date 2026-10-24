/**
 * Time-zone arithmetic for the tasks page (S10-05): the tabs ("today", "overdue") are the agency's calendar days, in
 * the platform time zone (`DEFAULT_TIME_ZONE`), not the server's. No dependency: `Intl` gives the zone's offset.
 */

/** The zone's offset from UTC at `at`, in ms (positive east of Greenwich). */
function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant at which the wall clock in `timeZone` reads the given fields (DST gaps resolve forward). */
export function zonedToUtc(
  f: { year: number; month: number; day: number; hour?: number; minute?: number },
  timeZone: string,
): Date {
  const wall = Date.UTC(f.year, f.month - 1, f.day, f.hour ?? 0, f.minute ?? 0);
  let guess = wall - offsetMs(new Date(wall), timeZone);
  guess = wall - offsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/** The start of `at`'s day in the zone and the start of the next one. */
export function dayBounds(at: Date, timeZone: string): { start: Date; end: Date } {
  const local = new Date(at.getTime() + offsetMs(at, timeZone));
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth() + 1;
  const d = local.getUTCDate();
  return {
    start: zonedToUtc({ year: y, month: m, day: d }, timeZone),
    end: zonedToUtc({ year: y, month: m, day: d + 1 }, timeZone),
  };
}

/** A `<input type="datetime-local">` value (`2026-10-24T09:30`) read in the zone; null when it is not one. */
export function parseLocalDateTime(value: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
  const at = zonedToUtc({ year, month, day, hour, minute }, timeZone);
  return Number.isNaN(at.getTime()) ? null : at;
}
