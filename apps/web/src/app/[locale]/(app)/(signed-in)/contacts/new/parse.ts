import { CONTACT_TYPES, CreateContactBody } from '@inmolink/contracts';

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

/** What the person typed, sent back to the form so a refusal never clears it. */
export interface ContactFormValues {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  types: string[];
  consentMarketing: boolean;
  consentProcessing: boolean;
}

export const EMPTY_CONTACT_FORM: ContactFormValues = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  types: [],
  consentMarketing: false,
  consentProcessing: false,
};

export function contactFormValues(form: FormData): ContactFormValues {
  const known = CONTACT_TYPES as readonly string[];
  return {
    firstName: text(form, 'firstName'),
    lastName: text(form, 'lastName'),
    email: text(form, 'email'),
    phone: text(form, 'phone'),
    types: form.getAll('types').filter((t): t is string => typeof t === 'string' && known.includes(t)),
    consentMarketing: form.get('consentMarketing') === 'on',
    consentProcessing: form.get('consentProcessing') === 'on',
  };
}

/** The API body of the form; null when the contract refuses it (no name, e-mail or phone, or a bad e-mail). */
export function contactBody(values: ContactFormValues, mergeInto?: string): CreateContactBody | null {
  const parsed = CreateContactBody.safeParse({
    types: values.types,
    firstName: values.firstName || null,
    lastName: values.lastName || null,
    emails: values.email ? [values.email] : [],
    phones: values.phone ? [values.phone] : [],
    consentMarketing: values.consentMarketing,
    consentProcessing: values.consentProcessing,
    ...(mergeInto ? { mergeInto } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/** The contacts a `CONTACT_DUPLICATE` refusal names (`details.matches`), without repeats; anything else is ignored. */
export function duplicateIds(details: unknown): string[] {
  const matches = (details as { matches?: unknown } | null | undefined)?.matches;
  if (!Array.isArray(matches)) return [];
  const ids = matches
    .map((m) => (m as { contactId?: unknown } | null)?.contactId)
    .filter((id): id is string => typeof id === 'string');
  return [...new Set(ids)];
}

export interface CreateContactState {
  values: ContactFormValues;
  /** An error code (i18n keys under `contacts.errors`). */
  error: string | null;
  /** The existing contacts of a duplicate refusal. */
  duplicates: string[];
}

export const initialCreateContactState: CreateContactState = {
  values: EMPTY_CONTACT_FORM,
  error: null,
  duplicates: [],
};
