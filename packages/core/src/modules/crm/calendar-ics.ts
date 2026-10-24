/**
 * A small iCalendar writer (S10-06, RFC 5545) for the members' ICS feeds — no dependency. What it guarantees:
 * - CRLF line endings, lines folded at 75 octets (UTF-8, never inside a character; continuation lines start with one
 *   space);
 * - TEXT values escaped (`\` → `\\`, `;` → `\;`, `,` → `\,`, newlines → `\n`), other control characters dropped;
 * - times in UTC (`…Z`, so no `VTIMEZONE` is needed); `UID` is the event's id (stable for its life); `DTSTAMP` and
 *   `LAST-MODIFIED` its last change; `SEQUENCE` its version - 1 (bumped on every change); a cancelled event is
 *   `STATUS:CANCELLED`;
 * - a pure function of its input: the same events give the same bytes (the feed's ETag is their hash).
 */

export interface IcsEvent {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  /** `SCHEDULED` or `CANCELLED`. */
  status: string;
  version: number;
  updatedAt: Date;
  /** The `CATEGORIES` value (the event type, translated). */
  category: string;
  /** Extra description lines (attendees' names), appended after a blank line. */
  notes: readonly string[];
}

export interface IcsCalendar {
  /** `X-WR-CALNAME`: what Google / Outlook name the subscription. */
  name: string;
  /** `REFRESH-INTERVAL` / `X-PUBLISHED-TTL` hint, minutes. */
  refreshMinutes: number;
  events: readonly IcsEvent[];
}

export const ICS_PRODID = '-//Inmolink//CRM Calendar 1.0//EN';
/** `UID` domain part: one product-wide constant (never a URL). */
const UID_DOMAIN = 'calendar.inmolink';

const CRLF = '\r\n';
const MAX_OCTETS = 75;

const NEEDS_ESCAPE = /[\\;,\u2028\u2029\p{Cc}]/u;
const ASCII = /^[\x20-\x7e]*$/;

/** RFC 5545 §3.3.11 TEXT escaping; line breaks of any kind become `\n`, other control characters go. */
export function escapeText(value: string): string {
  // most values need nothing (S11-F7: six passes over every title of a 1,000-event feed add up)
  if (!NEEDS_ESCAPE.test(value)) return value;
  return value
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/(?![\n\t])\p{Cc}/gu, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/** `20261024T093000Z`. */
export function utcStamp(at: Date): string {
  const iso = at.toISOString();
  // `YYYY-MM-DDTHH:MM:SS.sssZ` (years 0–9999): slices, no regular expressions (S11-F7: four per event)
  if (iso.length === 24) {
    return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  }
  return iso.replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

/** Folds one content line at 75 octets (RFC 5545 §3.1), never splitting a UTF-8 character. */
export function foldLine(line: string): string {
  // a short printable-ASCII line is one octet per character: nothing to fold (most lines)
  if (ASCII.test(line)) {
    if (line.length <= MAX_OCTETS) return line;
    // one octet per character: 75, then 74 after each continuation's leading space
    const parts = [line.slice(0, MAX_OCTETS)];
    for (let i = MAX_OCTETS; i < line.length; i += MAX_OCTETS - 1) parts.push(line.slice(i, i + MAX_OCTETS - 1));
    return parts.join(`${CRLF} `);
  }
  // S11-F7: octets from the code point (a lone surrogate is written as U+FFFD: 3 octets), slices instead of per-character
  // strings — the same output as measuring each character with `Buffer.byteLength`
  const parts: string[] = [];
  let start = 0;
  let octets = 0;
  for (let i = 0; i < line.length; ) {
    const cp = line.codePointAt(i) as number;
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (octets + size > MAX_OCTETS) {
      parts.push(line.slice(start, i));
      start = i;
      octets = 1 + size; // the continuation line's leading space
    } else {
      octets += size;
    }
    i += cp > 0xffff ? 2 : 1;
  }
  parts.push(line.slice(start));
  return parts.join(`${CRLF} `);
}

function eventLines(e: IcsEvent): string[] {
  const description = [e.description ?? '', ...(e.notes.length > 0 ? ['', ...e.notes] : [])].join('\n').trim();
  const stamp = utcStamp(e.updatedAt);
  return [
    'BEGIN:VEVENT',
    `UID:${e.id}@${UID_DOMAIN}`,
    `DTSTAMP:${stamp}`,
    `LAST-MODIFIED:${stamp}`,
    `DTSTART:${utcStamp(e.startsAt)}`,
    `DTEND:${utcStamp(e.endsAt)}`,
    `SEQUENCE:${Math.max(0, e.version - 1)}`,
    `SUMMARY:${escapeText(e.title)}`,
    ...(e.location ? [`LOCATION:${escapeText(e.location)}`] : []),
    ...(description ? [`DESCRIPTION:${escapeText(description)}`] : []),
    `CATEGORIES:${escapeText(e.category)}`,
    `STATUS:${e.status === 'CANCELLED' ? 'CANCELLED' : 'CONFIRMED'}`,
    `TRANSP:${e.status === 'CANCELLED' ? 'TRANSPARENT' : 'OPAQUE'}`,
    'CLASS:PRIVATE',
    'END:VEVENT',
  ];
}

/** The whole `VCALENDAR` (`text/calendar; charset=utf-8`), CRLF-terminated. */
export function renderIcs(cal: IcsCalendar): string {
  const ttl = `PT${Math.max(1, Math.round(cal.refreshMinutes))}M`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${ICS_PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(cal.name)}`,
    `X-PUBLISHED-TTL:${ttl}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${ttl}`,
    ...cal.events.flatMap(eventLines),
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join(CRLF) + CRLF;
}
