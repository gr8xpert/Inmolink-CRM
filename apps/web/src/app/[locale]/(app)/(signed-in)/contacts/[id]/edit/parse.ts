import { CONTACT_TYPES, type ContactDto, UpdateContactBody } from '@inmolink/contracts';

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

const lines = (value: string) =>
  value
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);

/** What the person typed, sent back to the form so a refusal never clears it. Lists are one value per line. */
export interface ContactEditValues {
  firstName: string;
  lastName: string;
  emails: string;
  phones: string;
  language: string;
  tags: string;
  types: string[];
  consentMarketing: boolean;
  consentProcessing: boolean;
  doNotContact: boolean;
}

/** The form's starting values: every e-mail, phone and tag the contact holds, so saving never drops one. */
export function editValuesOf(contact: ContactDto): ContactEditValues {
  return {
    firstName: contact.firstName ?? '',
    lastName: contact.lastName ?? '',
    emails: contact.emails.join('\n'),
    phones: contact.phones.join('\n'),
    language: contact.language ?? '',
    tags: contact.tags.join('\n'),
    types: contact.types,
    consentMarketing: contact.consentMarketing,
    consentProcessing: contact.consentProcessing,
    doNotContact: contact.doNotContact,
  };
}

export function contactEditValues(form: FormData): ContactEditValues {
  const known = CONTACT_TYPES as readonly string[];
  return {
    firstName: text(form, 'firstName'),
    lastName: text(form, 'lastName'),
    emails: text(form, 'emails'),
    phones: text(form, 'phones'),
    language: text(form, 'language'),
    tags: text(form, 'tags'),
    types: form.getAll('types').filter((t): t is string => typeof t === 'string' && known.includes(t)),
    consentMarketing: form.get('consentMarketing') === 'on',
    consentProcessing: form.get('consentProcessing') === 'on',
    doNotContact: form.get('doNotContact') === 'on',
  };
}

/**
 * The API body of the form at the `version` it was loaded with; null when the contract refuses it or nothing would
 * identify the person. Source and responsible agent are not on the form, so they are never sent. Consents are sent as
 * they stand: the service compares them with the contact and records only a real change.
 */
export function contactEditBody(values: ContactEditValues, version: number): UpdateContactBody | null {
  const emails = lines(values.emails);
  const phones = lines(values.phones);
  if (!values.firstName && !values.lastName && emails.length === 0 && phones.length === 0) return null;
  const parsed = UpdateContactBody.safeParse({
    version,
    types: values.types,
    firstName: values.firstName || null,
    lastName: values.lastName || null,
    emails,
    phones,
    language: values.language || null,
    tags: lines(values.tags),
    consentMarketing: values.consentMarketing,
    consentProcessing: values.consentProcessing,
    doNotContact: values.doNotContact,
  });
  return parsed.success ? parsed.data : null;
}

export interface EditContactState {
  values: ContactEditValues | null;
  /** An error code (i18n keys under `contacts.errors`). */
  error: string | null;
  /** The other contacts holding an e-mail or phone of the form. */
  duplicates: string[];
}

export const initialEditContactState: EditContactState = { values: null, error: null, duplicates: [] };
