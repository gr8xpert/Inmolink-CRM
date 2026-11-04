import { readFileSync } from 'node:fs';
import { StartContactImportBody } from '@inmolink/contracts';
import { loadMessages } from '@inmolink/i18n/server';
import { describe, expect, it } from 'vitest';
import {
  columnFieldsFrom,
  DEFAULT_IMPORT_OPTIONS,
  hasConsentColumn,
  hasIdentityColumn,
  IMPORT_FIELDS,
  setColumnField,
  toMapping,
  toStartInput,
} from './import-state';

describe('contact import columns', () => {
  it('[S17-F29] the columns start from the API guess, but a marketing consent column is never preselected', () => {
    const fields = columnFieldsFrom({ fullName: 0, emails: [1, 2], consentMarketing: 3, doNotContact: 4 }, 5);
    expect(fields).toEqual(['fullName', 'emails', 'emails', '', 'doNotContact']);
    expect(hasConsentColumn(fields)).toBe(false);
  });

  it('[S17-F29] a marketing consent column counts only when the person chooses it', () => {
    const chosen = setColumnField(['emails', ''], 1, 'consentMarketing');
    expect(hasConsentColumn(chosen)).toBe(true);
    expect(StartContactImportBody.parse(toStartInput(chosen, DEFAULT_IMPORT_OPTIONS)).mapping.consentMarketing).toBe(1);
  });

  it('[S17-F29] a single-column field moves between columns; e-mail and phone take up to five', () => {
    expect(setColumnField(['firstName', ''], 1, 'firstName')).toEqual(['', 'firstName']);
    expect(setColumnField(['emails', ''], 1, 'emails')).toEqual(['emails', 'emails']);
    const five = ['emails', 'emails', 'emails', 'emails', 'emails', ''] as const;
    expect(setColumnField(five, 5, 'emails')).toEqual(five);
    expect(setColumnField(five, 0, 'phones')[0]).toBe('phones');
  });

  it('[S17-F29] the screen asks for a name, e-mail or phone column as the contract does', () => {
    expect(hasIdentityColumn(['note', ''])).toBe(false);
    expect(StartContactImportBody.safeParse({ mapping: toMapping(['note', '']) }).success).toBe(false);
    expect(hasIdentityColumn(['note', 'phones'])).toBe(true);
    expect(StartContactImportBody.safeParse({ mapping: toMapping(['note', 'phones']) }).success).toBe(true);
  });

  it('[S17-F29] by default duplicates are skipped and no consent is given', () => {
    const body = StartContactImportBody.parse(toStartInput(['emails'], DEFAULT_IMPORT_OPTIONS));
    expect(body).toMatchObject({ onDuplicate: 'SKIP', consentProcessing: false, phoneCountry: 'ES', tags: [] });
    expect(body.mapping.consentMarketing).toBeUndefined();
  });

  it('[S17-F29] tags are split on commas and the country is upper-cased', () => {
    const input = toStartInput(['emails'], { ...DEFAULT_IMPORT_OPTIONS, tags: ' feria, golf ,, ', phoneCountry: 'gb' });
    expect(input).toMatchObject({ tags: ['feria', 'golf'], phoneCountry: 'GB' });
  });
});

describe('contact import strings', () => {
  const lookup = (messages: unknown, key: string) =>
    key.split('.').reduce<unknown>((v, part) => (v as Record<string, unknown> | undefined)?.[part], messages);
  const source = readFileSync(new URL('./import-panel.tsx', import.meta.url), 'utf8');
  const literal = [...source.matchAll(/\bt\('([^']+)'/g)].map((m) => m[1] as string);
  const dynamic = [
    ...IMPORT_FIELDS.map((f) => `import.mapFields.${f}`),
    ...['NEW', 'EXISTING', 'REPEATED', 'INVALID'].map((s) => `import.previewStatus.${s}`),
    ...['NO_IDENTITY', 'INVALID_EMAIL', 'INVALID_PHONE', 'TOO_LONG', 'DUPLICATE_RACE'].map(
      (c) => `import.rowErrors.${c}`,
    ),
    ...['RATE_LIMITED', 'PAYLOAD_TOO_LARGE', 'FORBIDDEN', 'CONTACT_IMPORT_FILE_INVALID', 'PLAN_REQUIRED'].map(
      (c) => `errors.${c}`,
    ),
  ];

  it.each(['en', 'es'] as const)('[S17-F29] every string of the screen exists in %s', (locale) => {
    const { contacts } = loadMessages(locale) as unknown as { contacts: unknown };
    expect(literal.length).toBeGreaterThan(20);
    for (const key of [...literal, ...dynamic]) expect(typeof lookup(contacts, key), key).toBe('string');
  });
});
