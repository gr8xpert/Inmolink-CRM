import { StartContactImportBody } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import { parseRow, suggestMapping } from '../import';
import { normalizeEmail, normalizePhone } from '../normalize';

describe('contact identifiers', () => {
  it('[S10-01] phones are normalized to E.164 whatever the writing; invalid ones are refused', () => {
    for (const raw of ['600 123 456', '+34 600-123-456', '0034600123456', '(+34) 600.123.456']) {
      expect(normalizePhone(raw, 'ES'), raw).toBe('+34600123456');
    }
    expect(normalizePhone('020 7946 0958', 'GB')).toBe('+442079460958');
    expect(normalizePhone('+44 20 7946 0958', 'ES')).toBe('+442079460958');
    expect(normalizePhone('12345', 'ES')).toBeNull();
    expect(normalizePhone('call me', 'ES')).toBeNull();
  });

  it('[S10-01] e-mails are trimmed and lower-cased', () => {
    expect(normalizeEmail('  Ana.Ruiz@Example.COM ')).toBe('ana.ruiz@example.com');
    expect(normalizeEmail('not-an-email')).toBeNull();
  });
});

describe('import mapping', () => {
  const settings = StartContactImportBody.omit({ onDuplicate: true }).parse({
    mapping: { fullName: 0, emails: [1, 2], phones: [3], types: 4, consentMarketing: 5, language: 6 },
    defaultTypes: ['BUYER'],
  });

  it('[S10-01] a row is read with the mapping: full name split, several e-mails, Spanish types, yes/no flags', () => {
    expect(
      parseRow(
        [
          'María José Ruiz',
          'MJ@Example.com',
          'mj@example.com; mj2@example.com',
          '600123456',
          'vendedora, propietaria',
          'Sí',
          'ES',
        ],
        2,
        settings,
      ),
    ).toMatchObject({
      row: 2,
      firstName: 'María',
      lastName: 'José Ruiz',
      emails: ['mj@example.com', 'mj2@example.com'],
      phones: ['+34600123456'],
      types: ['SELLER', 'LANDLORD'],
      consentMarketing: true,
      language: 'es',
    });
    expect(parseRow(['Ana', '', '', '', '', '', ''], 3, settings)).toMatchObject({
      types: ['BUYER'],
      consentMarketing: false,
    });
  });

  it('[S10-01] bad rows give a code, never a value', () => {
    expect(parseRow(['', 'bad', '', '', '', '', ''], 4, settings)).toEqual({ row: 4, code: 'INVALID_EMAIL' });
    expect(parseRow(['', '', '', '123', '', '', ''], 5, settings)).toEqual({ row: 5, code: 'INVALID_PHONE' });
    expect(parseRow(['', '', '', '', 'buyer', '', ''], 6, settings)).toEqual({ row: 6, code: 'NO_IDENTITY' });
  });

  it('[S10-01] the mapper starts from a mapping guessed from English or Spanish headers', () => {
    expect(suggestMapping(['Nombre', 'Apellidos', 'Correo', 'Móvil', 'Teléfono fijo', 'Idioma', 'Notas'])).toEqual({
      firstName: 0,
      lastName: 1,
      emails: [2],
      phones: [3, 4],
      language: 5,
      note: 6,
    });
    expect(suggestMapping(['Full name', 'E-mail', 'Tags'])).toEqual({ fullName: 0, emails: [1], tags: 2 });
    // opt-out columns are never read as a consent (S10-01 review)
    expect(suggestMapping(['Email', 'Unsubscribed', 'Baja', 'Newsletter opt-in'])).toEqual({
      emails: [0],
      doNotContact: 1,
      consentMarketing: 3,
    });
  });
});
