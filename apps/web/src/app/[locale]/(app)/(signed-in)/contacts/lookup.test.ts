import { describe, expect, it } from 'vitest';
import { contactName, lookupBody } from './lookup';

describe('contact lookup input', () => {
  it('[S11-F14] an input with an @ is an e-mail lookup, anything else a phone lookup', () => {
    expect(lookupBody(' Ana@Example.com ')).toMatchObject({ emails: ['ana@example.com'], phones: [] });
    expect(lookupBody('+34 600 111 222')).toMatchObject({ emails: [], phones: ['+34 600 111 222'] });
  });

  it('[S11-F14] empty, oversized, non-text and invalid inputs are no lookup', () => {
    expect(lookupBody('')).toBeNull();
    expect(lookupBody('   ')).toBeNull();
    expect(lookupBody(undefined)).toBeNull();
    expect(lookupBody('not-an-email@')).toBeNull();
    expect(lookupBody('x'.repeat(300))).toBeNull();
  });

  it('[S11-F14] a contact is shown by name, else e-mail, else phone', () => {
    expect(contactName({ firstName: 'Ana', lastName: 'Ruiz', primaryEmail: 'a@b.es' })).toBe('Ana Ruiz');
    expect(contactName({ firstName: null, lastName: null, primaryEmail: 'a@b.es' })).toBe('a@b.es');
    expect(contactName({ firstName: null, lastName: null, primaryPhone: '+34600111222' })).toBe('+34600111222');
    expect(contactName({ firstName: null, lastName: null })).toBeNull();
  });
});
