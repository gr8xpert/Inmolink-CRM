import type { ContactDto } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import { contactEditBody, contactEditValues, editValuesOf } from './parse';

const CONTACT: ContactDto = {
  id: '01900000-0000-7000-8000-000000000001',
  types: ['BUYER'],
  firstName: 'Ana',
  lastName: null,
  emails: ['ana@example.com', 'ana.work@example.com'],
  phones: ['+34600000001'],
  language: 'es',
  source: 'IMPORT',
  tags: ['golf', 'feria, 2026'],
  consentMarketing: true,
  consentMarketingAt: '2026-10-01T09:00:00.000Z',
  consentProcessing: false,
  consentProcessingAt: null,
  doNotContact: false,
  ownerUserId: null,
  version: 4,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
};

/** The form as a browser posts it: unticked boxes are absent. */
function posted(values: Record<string, string | string[]>): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(values)) for (const one of [v].flat()) form.append(k, one);
  return form;
}

describe('contact edit form', () => {
  it('[S17-F28] saving an untouched form sends every e-mail, phone and tag and the consents as they stand', () => {
    const v = editValuesOf(CONTACT);
    const form = posted({
      firstName: v.firstName,
      emails: v.emails,
      phones: v.phones,
      language: v.language,
      tags: v.tags,
      types: v.types,
      consentMarketing: 'on',
    });
    expect(contactEditBody(contactEditValues(form), CONTACT.version)).toEqual({
      version: 4,
      types: ['BUYER'],
      firstName: 'Ana',
      lastName: null,
      emails: ['ana@example.com', 'ana.work@example.com'],
      phones: ['+34600000001'],
      language: 'es',
      tags: ['golf', 'feria, 2026'],
      consentMarketing: true,
      consentProcessing: false,
      doNotContact: false,
    });
  });

  it('[S17-F28] lists left as loaded are not sent, so a stored value the contract refuses cannot block a save', () => {
    const v = { ...editValuesOf(CONTACT), emails: 'josé@example.com', firstName: 'Anna' };
    const body = contactEditBody(v, 4, { emails: 'josé@example.com\r\n', phones: v.phones });
    expect(body).toMatchObject({ firstName: 'Anna' });
    expect(body).not.toHaveProperty('emails');
    expect(body).not.toHaveProperty('phones');
    const changed = contactEditBody({ ...v, emails: 'new@example.com' }, 4, { emails: v.emails, phones: v.phones });
    expect(changed?.emails).toEqual(['new@example.com']);
  });

  it('[S17-F28] the body carries the loaded version, and never the source or the responsible agent', () => {
    const body = contactEditBody(editValuesOf(CONTACT), 7);
    expect(body?.version).toBe(7);
    expect(body).not.toHaveProperty('source');
    expect(body).not.toHaveProperty('ownerUserId');
  });

  it('[S17-F28] Windows line ends and blank lines do not make values', () => {
    const form = posted({ firstName: 'Ana', emails: 'a@example.com\r\n\r\n b@example.com \r\n' });
    expect(contactEditBody(contactEditValues(form), 1)?.emails).toEqual(['a@example.com', 'b@example.com']);
  });

  it('[S17-F28] the field rules hold: no identity, a bad e-mail or a bad language refuse the form', () => {
    const blank = { ...editValuesOf(CONTACT), firstName: '', lastName: '', emails: '', phones: '' };
    expect(contactEditBody(blank, 1)).toBeNull();
    expect(contactEditBody({ ...editValuesOf(CONTACT), emails: 'not-an-address' }, 1)).toBeNull();
    expect(contactEditBody({ ...editValuesOf(CONTACT), language: 'spanish' }, 1)).toBeNull();
  });

  it('[S17-F28] an unknown contact type posted to the form is dropped', () => {
    const form = posted({ firstName: 'Ana', types: ['BUYER', 'HACKER'] });
    expect(contactEditValues(form).types).toEqual(['BUYER']);
  });
});
