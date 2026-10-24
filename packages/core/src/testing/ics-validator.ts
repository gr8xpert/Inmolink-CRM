/**
 * A strict RFC 5545 checker for the calendar feed tests (S10-06) — independent of the writer: it parses the raw bytes
 * and reports every rule broken. Checked: CRLF-only line endings and a final CRLF; physical lines ≤ 75 octets, each
 * valid UTF-8 on its own (a fold inside a character fails the fatal decoder), folded with one leading space; no control
 * characters but HTAB; well-nested BEGIN/END with VCALENDAR outside and no VEVENT inside a VEVENT; VCALENDAR's
 * VERSION:2.0 and PRODID (once each); every VEVENT's UID, DTSTAMP and DTSTART (once each), DTEND after DTSTART and never
 * with DURATION, UTC date-times, an integer SEQUENCE, a known STATUS; TEXT values with only valid escapes, no bare `,`
 * or `;` (single-valued properties) and no bare `;` in CATEGORIES (a list: `,` separates). Returns the events.
 */

export interface ParsedProperty {
  name: string;
  params: string;
  value: string;
}
export interface ParsedEvent {
  props: Map<string, ParsedProperty[]>;
  /** A single-valued property's unescaped TEXT value. */
  text(name: string): string | undefined;
  raw(name: string): string | undefined;
}

const UTC = /^\d{8}T\d{6}Z$/;
const TEXT_PROPS = new Set(['SUMMARY', 'DESCRIPTION', 'LOCATION', 'X-WR-CALNAME']);
const LIST_TEXT_PROPS = new Set(['CATEGORIES']);
const STATUSES = new Set(['TENTATIVE', 'CONFIRMED', 'CANCELLED']);
const CR = 13;
const LF = 10;
const HTAB = String.fromCharCode(9);
const DEL = String.fromCharCode(127);

function unescapeText(value: string, problems: string[], where: string, list = false): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string;
    if (c === '\\') {
      const n = value[i + 1];
      if (n === 'n' || n === 'N') out += '\n';
      else if (n === '\\' || n === ';' || n === ',') out += n;
      else problems.push(`${where}: invalid escape \\${n ?? ''}`);
      i++;
    } else {
      if (c === ';' || (c === ',' && !list)) problems.push(`${where}: unescaped ${c}`);
      out += c;
    }
  }
  return out;
}

const utcMs = (v: string) =>
  Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(9, 11), +v.slice(11, 13), +v.slice(13, 15));

/** Splits the raw bytes at CRLF and decodes each physical line on its own (fatal: a split character throws). */
function physicalLines(bytes: Uint8Array, problems: string[]): string[] {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === CR) {
      if (bytes[i + 1] !== LF) problems.push(`bare CR at byte ${i}`);
      const raw = bytes.subarray(start, i);
      if (raw.length > 75) problems.push(`line ${lines.length + 1}: ${raw.length} octets`);
      try {
        lines.push(decoder.decode(raw));
      } catch {
        problems.push(`line ${lines.length + 1}: not valid UTF-8 on its own (folded inside a character)`);
        lines.push('');
      }
      i++;
      start = i + 1;
    } else if (b === LF) problems.push(`bare LF at byte ${i}`);
  }
  if (start !== bytes.length) problems.push('does not end with CRLF');
  return lines;
}

export function validateIcs(input: string | Uint8Array): { problems: string[]; events: ParsedEvent[] } {
  const problems: string[] = [];
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const physical = physicalLines(bytes, problems);
  const logical: string[] = [];
  physical.forEach((line) => {
    if (line.startsWith(' ') || line.startsWith(HTAB)) {
      if (logical.length === 0) problems.push('continuation without a line');
      else logical[logical.length - 1] += line.slice(1);
    } else logical.push(line);
  });
  for (const line of logical) {
    for (const ch of line) {
      const code = ch.charCodeAt(0);
      if ((code < 32 && ch !== HTAB) || ch === DEL) {
        problems.push(`control character ${code} in "${line.slice(0, 30)}"`);
        break;
      }
    }
  }

  const stack: string[] = [];
  const events: ParsedEvent[] = [];
  let calendar: Map<string, ParsedProperty[]> | null = null;
  let current: Map<string, ParsedProperty[]> | null = null;
  for (const line of logical) {
    const colon = line.indexOf(':');
    if (colon <= 0) {
      problems.push(`no name:value in "${line.slice(0, 40)}"`);
      continue;
    }
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const [name = '', ...paramParts] = head.split(';');
    if (!/^[A-Z][A-Z0-9-]*$/.test(name)) problems.push(`bad property name ${name}`);
    if (name === 'BEGIN') {
      if (stack.length === 0 && value !== 'VCALENDAR') problems.push('outermost component is not VCALENDAR');
      if (value === 'VEVENT' && stack.includes('VEVENT')) problems.push('VEVENT nested in a VEVENT');
      stack.push(value);
      if (value === 'VCALENDAR') calendar = new Map();
      if (value === 'VEVENT') current = new Map();
      continue;
    }
    if (name === 'END') {
      const open = stack.pop();
      if (open !== value) problems.push(`END:${value} closes ${open ?? 'nothing'}`);
      if (value === 'VEVENT' && current) {
        const props = current;
        events.push({
          props,
          raw: (n) => props.get(n)?.[0]?.value,
          text: (n) => {
            const p = props.get(n)?.[0];
            return p ? unescapeText(p.value, [], n, LIST_TEXT_PROPS.has(n)) : undefined;
          },
        });
        current = null;
      }
      continue;
    }
    const target = current ?? calendar;
    if (!target) {
      problems.push(`${name} outside a component`);
      continue;
    }
    const list = target.get(name) ?? [];
    list.push({ name, params: paramParts.join(';'), value });
    target.set(name, list);
    if (TEXT_PROPS.has(name)) unescapeText(value, problems, name);
    if (LIST_TEXT_PROPS.has(name)) unescapeText(value, problems, name, true);
  }
  if (stack.length > 0) problems.push(`unclosed ${stack.join(', ')}`);
  if (!calendar) problems.push('no VCALENDAR');
  else {
    if (calendar.get('VERSION')?.length !== 1 || calendar.get('VERSION')?.[0]?.value !== '2.0') {
      problems.push('VERSION:2.0 missing or repeated');
    }
    if (calendar.get('PRODID')?.length !== 1) problems.push('PRODID missing or repeated');
  }
  for (const e of events) {
    const uid = e.raw('UID') ?? '?';
    for (const req of ['UID', 'DTSTAMP', 'DTSTART']) {
      if (e.props.get(req)?.length !== 1) problems.push(`${uid}: ${req} missing or repeated`);
    }
    if (e.props.has('DTEND') && e.props.has('DURATION')) problems.push(`${uid}: both DTEND and DURATION`);
    for (const t of ['DTSTAMP', 'DTSTART', 'DTEND', 'LAST-MODIFIED']) {
      const v = e.raw(t);
      if (v !== undefined && !UTC.test(v)) problems.push(`${uid}: ${t} is not a UTC date-time (${v})`);
    }
    const start = e.raw('DTSTART');
    const end = e.raw('DTEND');
    if (start && end && UTC.test(start) && UTC.test(end) && utcMs(end) <= utcMs(start)) {
      problems.push(`${uid}: DTEND not after DTSTART`);
    }
    const seq = e.raw('SEQUENCE');
    if (seq !== undefined && !/^\d+$/.test(seq)) problems.push(`${uid}: SEQUENCE ${seq}`);
    const status = e.raw('STATUS');
    if (status !== undefined && !STATUSES.has(status)) problems.push(`${uid}: STATUS ${status}`);
  }
  return { problems, events };
}
