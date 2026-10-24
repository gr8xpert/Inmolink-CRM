import { describe, expect, it } from 'vitest';
import { validateIcs } from '../../../testing/ics-validator';
import { escapeText, foldLine, type IcsEvent, renderIcs } from '../calendar-ics';

const event = (over: Partial<IcsEvent> = {}): IcsEvent => ({
  id: '01900000-0000-7000-8000-0000000000e1',
  title: 'Viewing, Calle Mayor; 3',
  description: null,
  location: null,
  startsAt: new Date('2026-11-02T09:30:00Z'),
  endsAt: new Date('2026-11-02T10:30:00Z'),
  status: 'SCHEDULED',
  version: 1,
  updatedAt: new Date('2026-10-24T08:00:00.123Z'),
  category: 'Viewing',
  notes: [],
  ...over,
});

describe('ICS writer (RFC 5545)', () => {
  it('[S10-06] the feed validates: CRLF, 75-octet folding, escaping of , ; \\ and newlines, UTC times, required properties', () => {
    const long = `Señora Müller — ${'ñ'.repeat(120)} 🏠 end`;
    const body = renderIcs({
      name: 'Inmolink, calendar',
      refreshMinutes: 15,
      events: [
        event({
          description: `Line one\nLine two; with, punctuation\\ and a backslash\r\nCRLF line${String.fromCharCode(7)}`,
          location: long,
          notes: ['With: Ana López, Bob'],
        }),
        event({ id: '01900000-0000-7000-8000-0000000000e2', status: 'CANCELLED', version: 4 }),
      ],
    });
    const { problems, events } = validateIcs(body);
    expect(problems).toEqual([]);
    expect(body.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(body.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(body.split('\r\n').some((l) => l.startsWith(' '))).toBe(true); // something was folded
    const [first, second] = events;
    expect(first?.text('SUMMARY')).toBe('Viewing, Calle Mayor; 3');
    expect(first?.raw('SUMMARY')).toBe('Viewing\\, Calle Mayor\\; 3');
    expect(first?.text('LOCATION')).toBe(long);
    expect(first?.text('DESCRIPTION')).toBe(
      'Line one\nLine two; with, punctuation\\ and a backslash\nCRLF line\n\nWith: Ana López, Bob',
    );
    expect(first?.raw('DTSTART')).toBe('20261102T093000Z');
    expect(first?.raw('DTEND')).toBe('20261102T103000Z');
    expect(first?.raw('DTSTAMP')).toBe('20261024T080000Z');
    expect(first?.raw('UID')).toBe('01900000-0000-7000-8000-0000000000e1@calendar.inmolink');
    expect(first?.raw('SEQUENCE')).toBe('0');
    expect(first?.raw('STATUS')).toBe('CONFIRMED');
    expect(second?.raw('STATUS')).toBe('CANCELLED');
    expect(second?.raw('SEQUENCE')).toBe('3');
  });

  it('[S10-06] folding never splits a multi-byte character and keeps every physical line ≤ 75 octets', () => {
    for (const ch of ['a', 'ñ', '€', '🏠']) {
      for (let n = 60; n < 90; n++) {
        const folded = foldLine(`DESCRIPTION:${ch.repeat(n)}`);
        for (const line of folded.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
        expect(
          folded
            .split('\r\n')
            .map((l, i) => (i === 0 ? l : l.slice(1)))
            .join(''),
        ).toBe(`DESCRIPTION:${ch.repeat(n)}`);
      }
    }
    expect(escapeText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
  });

  it('[S10-06] the same events give the same bytes (a stable ETag)', () => {
    const cal = { name: 'X', refreshMinutes: 15, events: [event()] };
    expect(renderIcs(cal)).toBe(renderIcs(cal));
  });

  it('[S10-06] the validator is strict: a fold inside a character, nested events, control characters, DTEND with DURATION', () => {
    const NL = String.fromCharCode(13, 10);
    const ok = renderIcs({ name: 'X', refreshMinutes: 15, events: [event()] });
    expect(validateIcs(ok).problems).toEqual([]);
    const bytes = new TextEncoder().encode(ok.replace('SUMMARY:Viewing', 'SUMMARY:Visit ñ'));
    // a fold between the two bytes of ñ: CRLF + space inside the character
    const at = bytes.findIndex((b, i) => b === 0xc3 && bytes[i + 1] === 0xb1);
    const split = new Uint8Array([...bytes.subarray(0, at + 1), 13, 10, 32, ...bytes.subarray(at + 1)]);
    expect(validateIcs(split).problems.join()).toMatch(/not valid UTF-8/);
    const nested = ok.replace('END:VEVENT', `BEGIN:VEVENT${NL}UID:x${NL}END:VEVENT${NL}END:VEVENT`);
    expect(validateIcs(nested).problems.join()).toMatch(/nested/);
    const control = ok.replace('SUMMARY:Viewing', `SUMMARY:View${String.fromCharCode(1)}ing`);
    expect(validateIcs(control).problems.join()).toMatch(/control character/);
    const both = ok.replace('END:VEVENT', `DURATION:PT1H${NL}END:VEVENT`);
    expect(validateIcs(both).problems.join()).toMatch(/DTEND and DURATION/);
    const category = ok.replace('CATEGORIES:Viewing', 'CATEGORIES:A;B');
    expect(validateIcs(category).problems.join()).toMatch(/CATEGORIES: unescaped ;/);
    expect(validateIcs('BEGIN:VCALENDAR\nVERSION:2.0\r\nEND:VCALENDAR\r\n').problems).not.toEqual([]);
  });
});

describe('fast paths (S11-F7)', () => {
  /** The S10-06 implementations, kept as the reference the fast ones must match byte for byte. */
  const referenceFold = (line: string) => {
    const out: string[] = [];
    let current = '';
    let octets = 0;
    for (const ch of line) {
      const size = Buffer.byteLength(ch, 'utf8');
      if (octets + size > 75) {
        out.push(current);
        current = ` ${ch}`;
        octets = 1 + size;
      } else {
        current += ch;
        octets += size;
      }
    }
    out.push(current);
    return out.join('\r\n');
  };
  const referenceEscape = (value: string) =>
    value
      .replace(/\r\n?|[\u2028\u2029]/g, '\n')
      .replace(/(?![\n\t])\p{Cc}/gu, '')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n');

  it('[S11-F7] folding and escaping give the same bytes as the reference on ASCII, accents, emoji and controls', () => {
    const alphabet = [
      'a',
      'Z',
      ' ',
      '~',
      'é',
      'ñ',
      '€',
      '中',
      '😀',
      '\uD800',
      ';',
      ',',
      '\\',
      '\n',
      '\r',
      '\t',
      '\u0007',
      '\u2028',
    ];
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    for (let n = 0; n < 2_000; n += 1) {
      const length = next() % 240;
      let s = '';
      for (let i = 0; i < length; i += 1) s += alphabet[next() % alphabet.length];
      expect(escapeText(s)).toBe(referenceEscape(s));
      const line = `DESCRIPTION:${referenceEscape(s)}`;
      expect(foldLine(line)).toBe(referenceFold(line));
      expect(foldLine(s)).toBe(referenceFold(s));
    }
    expect(foldLine('')).toBe('');
    expect(foldLine('x'.repeat(75))).toBe('x'.repeat(75));
    expect(foldLine('x'.repeat(76))).toBe(`${'x'.repeat(75)}\r\n x`);
  });
});
