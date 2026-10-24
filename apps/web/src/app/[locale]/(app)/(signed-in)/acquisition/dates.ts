/**
 * Day arithmetic of the acquisition board's by-date view (S10-07): follow-ups grouped by the agency's calendar day in
 * the platform time zone (`DEFAULT_TIME_ZONE`), and the `datetime-local` value of a follow-up for the edit form.
 */

function parts(at: Date, timeZone: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at)) {
    out[p.type] = p.value;
  }
  return out;
}

/** `2026-10-24`: the day `at` falls on in the zone. */
export function dayKey(at: Date, timeZone: string): string {
  const p = parts(at, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** `2026-10-24T09:30`: the wall clock of `at` in the zone, as a `datetime-local` input value. */
export function localInputValue(at: Date, timeZone: string): string {
  const p = parts(at, timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Items (already in time order) in runs of one day each, in order. */
export function groupByDay<T>(
  items: readonly T[],
  at: (item: T) => Date,
  timeZone: string,
): { day: string; items: T[] }[] {
  const groups: { day: string; items: T[] }[] = [];
  for (const item of items) {
    const day = dayKey(at(item), timeZone);
    const last = groups.at(-1);
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}
