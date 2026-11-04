import { describe, expect, it } from 'vitest';
import { contactBody, contactFormValues, duplicateIds, EMPTY_CONTACT_FORM } from './parse';

const form = (entries: [string, string][]) => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};

describe('new contact form', () => {
  it('[S17-F19] reads the fields, trims them and keeps only known types', () => {
    const values = contactFormValues(
      form([
        ['firstName', ' Ana '],
        ['email', ' ana@example.com '],
        ['types', 'BUYER'],
        ['types', 'NOT_A_TYPE'],
        ['consentMarketing', 'on'],
      ]),
    );
    expect(values).toEqual({
      ...EMPTY_CONTACT_FORM,
      firstName: 'Ana',
      email: 'ana@example.com',
      types: ['BUYER'],
      consentMarketing: true,
    });
  });

  it('[S17-F19] needs a name, an e-mail or a phone, and a valid e-mail', () => {
    expect(contactBody(EMPTY_CONTACT_FORM)).toBeNull();
    expect(contactBody({ ...EMPTY_CONTACT_FORM, email: 'not-an-email' })).toBeNull();
    expect(contactBody({ ...EMPTY_CONTACT_FORM, firstName: 'Ana' })).toMatchObject({
      firstName: 'Ana',
      emails: [],
      phones: [],
      source: 'MANUAL',
    });
  });

  it('[S17-F19] the same details can be added to the contact a refusal named', () => {
    const id = '01a1a572-76d2-749a-880b-3ef8ed8fccc4';
    expect(contactBody({ ...EMPTY_CONTACT_FORM, phone: '+34600000001' }, id)).toMatchObject({ mergeInto: id });
  });

  it('[S17-F19] a duplicate refusal names each contact once; unexpected details name none', () => {
    const a = { contactId: 'a', on: 'email' };
    expect(duplicateIds({ matches: [a, { contactId: 'a', on: 'phone' }, { contactId: 'b', on: 'phone' }] })).toEqual([
      'a',
      'b',
    ]);
    expect(duplicateIds(null)).toEqual([]);
    expect(duplicateIds({ matches: 'x' })).toEqual([]);
  });
});
