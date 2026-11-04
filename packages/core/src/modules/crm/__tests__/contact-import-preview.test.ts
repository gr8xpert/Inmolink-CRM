import { describe, expect, it } from 'vitest';
import type { ParsedRow } from '../import';
import { parseRow } from '../import';
import { classifyRows } from '../import-preview';

const row = (n: number, emails: string[], extra: Partial<ParsedRow> = {}): ParsedRow => ({
  row: n,
  firstName: null,
  lastName: null,
  emails,
  phones: [],
  language: null,
  tags: [],
  types: [],
  consentMarketing: false,
  doNotContact: false,
  note: null,
  ...extra,
});

describe('classifyRows', () => {
  it('[S17-F29] tells new rows, existing contacts, repeats in the file and bad rows apart', () => {
    const out = classifyRows(
      [
        row(2, ['new@example.com'], { firstName: 'Ana', lastName: 'Sol' }),
        row(3, ['new@example.com']),
        row(4, ['old@example.com']),
        { row: 5, code: 'INVALID_EMAIL' },
      ],
      [{ contactId: 'c1', on: 'email', value: 'old@example.com' }],
      'SKIP',
    );
    expect(out.map((r) => [r.row, r.status, r.code, r.contactId])).toEqual([
      [2, 'NEW', null, null],
      [3, 'REPEATED', null, null],
      [4, 'EXISTING', null, 'c1'],
      [5, 'INVALID', 'INVALID_EMAIL', null],
    ]);
    expect(out[0]).toMatchObject({ name: 'Ana Sol', email: 'new@example.com' });
  });

  it('[S17-F29] follows the run: a skipped row claims nothing, a merged row claims its other identifiers', () => {
    const rows = [row(2, ['a@example.com']), row(3, ['a@example.com', 'b@example.com']), row(4, ['b@example.com'])];
    expect(classifyRows(rows, [], 'SKIP').map((r) => r.status)).toEqual(['NEW', 'REPEATED', 'NEW']);
    expect(classifyRows(rows, [], 'MERGE').map((r) => r.status)).toEqual(['NEW', 'REPEATED', 'REPEATED']);
  });

  it('[S17-F29] under merge a row follows its first claimed identifier, as the run does', () => {
    const rows = [row(2, ['a@example.com']), row(3, ['a@example.com', 'owned@example.com'])];
    const owners = [{ contactId: 'c1', on: 'email' as const, value: 'owned@example.com' }];
    expect(classifyRows(rows, owners, 'MERGE').map((r) => [r.status, r.contactId])).toEqual([
      ['NEW', null],
      ['REPEATED', null],
    ]);
  });

  it('[S17-F29] says consent only where the run would give it', () => {
    const yes = { consentMarketing: true };
    const rows = [
      row(2, ['new@example.com'], yes),
      row(3, ['new@example.com'], yes),
      row(4, ['free@example.com'], yes),
      row(5, ['chose@example.com'], yes),
    ];
    const owners = [
      { contactId: 'free', on: 'email' as const, value: 'free@example.com' },
      { contactId: 'chose', on: 'email' as const, value: 'chose@example.com' },
    ];
    const consent = (mode: 'SKIP' | 'MERGE') =>
      classifyRows(rows, owners, mode, new Set(['chose'])).map((r) => r.consentMarketing);
    expect(consent('SKIP')).toEqual([true, false, false, false]);
    expect(consent('MERGE')).toEqual([true, true, true, false]);
  });

  it('[S17-F29] a cell of thousands of values, or a column mapped five times, reads a bounded number of values', () => {
    const many = Array.from({ length: 20_000 }, (_, i) => `v${i}@example.com`).join(';');
    const started = performance.now();
    const parsed = parseRow([many], 2, {
      mapping: { emails: [0, 0, 0, 0, 0], phones: [] },
      defaultTypes: [],
      tags: [],
      phoneCountry: 'ES',
      consentProcessing: false,
    });
    expect(performance.now() - started).toBeLessThan(200);
    expect(parsed).toMatchObject({ emails: expect.any(Array) });
    expect((parsed as ParsedRow).emails).toHaveLength(10);
  });
});
