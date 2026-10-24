/**
 * CRM contacts (S10-01, PLAN §6 CRM, §7 M8): contacts with several e-mails and phones (E.164), language, source, tags,
 * consents and do-not-contact; notes; duplicate detection on e-mail and phone with merge; CSV / Excel import with a
 * column mapping. Contacts are the agency's clients (PII): STRICT tables, never in Client Mode, never logged.
 */
import { z } from 'zod';
import { PageQuery, pageOf } from './common';

export const CONTACT_TYPES = ['BUYER', 'SELLER', 'TENANT', 'LANDLORD'] as const;
export const ContactType = z.enum(CONTACT_TYPES);
export type ContactType = z.infer<typeof ContactType>;

export const CONTACT_SOURCES = [
  'MANUAL',
  'WEBSITE',
  'PORTAL',
  'IMPORT',
  'REFERRAL',
  'WALK_IN',
  'PHONE',
  'SOCIAL',
  'OTHER',
] as const;
export const ContactSource = z.enum(CONTACT_SOURCES);
export type ContactSource = z.infer<typeof ContactSource>;

/** Bounds of one contact (the database checks the identifier formats too). */
export const CONTACT_LIMITS = {
  emails: 10,
  phones: 10,
  tags: 30,
  tagChars: 50,
  nameChars: 120,
  noteChars: 10_000,
} as const;

/**
 * Country assumed for a phone written without an international prefix (`600 123 456` → `+34600123456`). Inmolink's
 * agencies are Spanish (PLAN §1); a request or an import mapping may name another one.
 */
export const DEFAULT_PHONE_COUNTRY = 'ES';
/** ISO 3166-1 alpha-2 country for national phone numbers. */
export const PhoneCountry = z.string().regex(/^[A-Z]{2}$/, 'an ISO 3166-1 alpha-2 code such as ES');

/** An e-mail as typed: trimmed and lower-cased (the stored, compared form). */
export const ContactEmail = z.string().trim().toLowerCase().pipe(z.email().max(254));
/** A phone as people write it (digits, spaces, `+ ( ) - .`); normalized to E.164 by the service, refused if invalid. */
export const ContactPhoneInput = z
  .string()
  .trim()
  .min(3)
  .max(40)
  .regex(/^[0-9+()\-. ]+$/, 'digits, spaces and + ( ) - . only');
export const ContactTag = z.string().trim().min(1).max(CONTACT_LIMITS.tagChars);
/** The contact's language (`en`, `es`, `pt-BR`). */
export const ContactLanguage = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/);
const name = z.string().trim().min(1).max(CONTACT_LIMITS.nameChars);

const contactFields = {
  types: z.array(ContactType).max(CONTACT_TYPES.length),
  firstName: name.nullable(),
  lastName: name.nullable(),
  emails: z.array(ContactEmail).max(CONTACT_LIMITS.emails),
  phones: z.array(ContactPhoneInput).max(CONTACT_LIMITS.phones),
  language: ContactLanguage.nullable(),
  source: ContactSource,
  tags: z.array(ContactTag).max(CONTACT_LIMITS.tags),
  consentMarketing: z.boolean(),
  consentProcessing: z.boolean(),
  doNotContact: z.boolean(),
  /** The responsible agent (a member of the agency); null = the agency's. */
  ownerUserId: z.uuid().nullable(),
};

/**
 * `POST /v1/crm/contacts`. A contact needs a name, an e-mail or a phone. When an e-mail or phone already belongs to a
 * contact the answer is `409 CONTACT_DUPLICATE` with `details.matches` (`[{ contactId, on: 'email' | 'phone' }]`) and
 * nothing is created; the client offers the merge and sends the same body again with `mergeInto` (one of the matches):
 * the new details are added to that contact instead.
 */
export const CreateContactBody = z
  .strictObject({
    types: contactFields.types.default([]),
    firstName: contactFields.firstName.default(null),
    lastName: contactFields.lastName.default(null),
    emails: contactFields.emails.default([]),
    phones: contactFields.phones.default([]),
    language: contactFields.language.default(null),
    source: contactFields.source.default('MANUAL'),
    tags: contactFields.tags.default([]),
    consentMarketing: contactFields.consentMarketing.default(false),
    consentProcessing: contactFields.consentProcessing.default(false),
    doNotContact: contactFields.doNotContact.default(false),
    ownerUserId: contactFields.ownerUserId.optional(),
    /** Country for phones without an international prefix (default `DEFAULT_PHONE_COUNTRY`). */
    phoneCountry: PhoneCountry.optional(),
    /** Add these details to this existing contact (the duplicate the 409 named) instead of creating one. */
    mergeInto: z.uuid().optional(),
  })
  .refine((v) => v.firstName || v.lastName || v.emails.length > 0 || v.phones.length > 0, {
    message: 'a name, an e-mail or a phone is required',
    path: ['firstName'],
  });
export type CreateContactBody = z.infer<typeof CreateContactBody>;
export type CreateContactInput = z.input<typeof CreateContactBody>;

/** `PATCH /v1/crm/contacts/:id`: the fields sent replace the current ones (`emails` / `phones`: the whole list). */
export const UpdateContactBody = z.strictObject({
  version: z.number().int().min(1),
  types: contactFields.types.optional(),
  firstName: contactFields.firstName.optional(),
  lastName: contactFields.lastName.optional(),
  emails: contactFields.emails.optional(),
  phones: contactFields.phones.optional(),
  language: contactFields.language.optional(),
  source: contactFields.source.optional(),
  tags: contactFields.tags.optional(),
  consentMarketing: contactFields.consentMarketing.optional(),
  consentProcessing: contactFields.consentProcessing.optional(),
  doNotContact: contactFields.doNotContact.optional(),
  ownerUserId: contactFields.ownerUserId.optional(),
  phoneCountry: PhoneCountry.optional(),
});
export type UpdateContactBody = z.infer<typeof UpdateContactBody>;

export const ContactDto = z.strictObject({
  id: z.uuid(),
  types: z.array(ContactType),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  /** Normalized (lower-case), primary first. */
  emails: z.array(z.string()),
  /** E.164, primary first. */
  phones: z.array(z.string()),
  language: z.string().nullable(),
  source: ContactSource,
  tags: z.array(z.string()),
  consentMarketing: z.boolean(),
  consentMarketingAt: z.iso.datetime().nullable(),
  consentProcessing: z.boolean(),
  consentProcessingAt: z.iso.datetime().nullable(),
  doNotContact: z.boolean(),
  ownerUserId: z.uuid().nullable(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ContactDto = z.infer<typeof ContactDto>;

export const ContactListItemDto = z.strictObject({
  id: z.uuid(),
  types: z.array(ContactType),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  primaryEmail: z.string().nullable(),
  primaryPhone: z.string().nullable(),
  tags: z.array(z.string()),
  doNotContact: z.boolean(),
  ownerUserId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type ContactListItemDto = z.infer<typeof ContactListItemDto>;
export const ContactPage = pageOf(ContactListItemDto);
export type ContactPage = z.infer<typeof ContactPage>;

/**
 * `GET /v1/crm/contacts`: newest first, keyset; `tag`, `type` and `owner` (`me` or a user id) filter the list. Lookups
 * by e-mail or phone are `POST /v1/crm/contacts/lookup` (PII stays out of URLs and access logs).
 */
export const ListContactsQuery = PageQuery.extend({
  tag: ContactTag.optional(),
  type: ContactType.optional(),
  owner: z.union([z.literal('me'), z.uuid()]).optional(),
});
export type ListContactsQuery = z.infer<typeof ListContactsQuery>;

export const ContactParams = z.strictObject({ id: z.uuid() });
export type ContactParams = z.infer<typeof ContactParams>;

/** A match of the duplicate check: the contact owning one of the e-mails / phones sent. */
export const ContactDuplicateMatch = z.strictObject({ contactId: z.uuid(), on: z.enum(['email', 'phone']) });
export type ContactDuplicateMatch = z.infer<typeof ContactDuplicateMatch>;

/**
 * `POST /v1/crm/contacts/lookup`: the contacts owning any of these e-mails / phones (normalized, exact) — the form's
 * live duplicate check and "find by e-mail or phone". In a body, so the values never sit in a URL.
 */
export const ContactLookupBody = z
  .strictObject({
    emails: z.array(ContactEmail).max(CONTACT_LIMITS.emails).default([]),
    phones: z.array(ContactPhoneInput).max(CONTACT_LIMITS.phones).default([]),
    phoneCountry: PhoneCountry.optional(),
  })
  .refine((v) => v.emails.length + v.phones.length > 0, {
    message: 'an e-mail or a phone is required',
    path: ['emails'],
  });
export type ContactLookupBody = z.infer<typeof ContactLookupBody>;
export const ContactLookupDto = z.strictObject({
  items: z.array(ContactListItemDto),
  matches: z.array(ContactDuplicateMatch),
});
export type ContactLookupDto = z.infer<typeof ContactLookupDto>;

/**
 * `POST /v1/crm/contacts` headers: an optional `Idempotency-Key` (`.claude/rules/api.md`) — a retry by the same member
 * within 24 h answers the contact the first request created (200) instead of a duplicate refusal.
 */
export const CreateContactHeaders = z.object({
  'idempotency-key': z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/)
    .optional(),
});

/**
 * `POST /v1/crm/contacts/:id/merge`: `duplicateId` is merged into the contact of the path (the survivor, at `version`).
 * Its e-mails, phones, notes and leads move to the survivor (as will the activities and tasks of S10-04/05, and
 * registrations via `crm.contact.merged`); the duplicate is closed (it answers `CONTACT_NOT_FOUND` from then on). A
 * result over `CONTACT_LIMITS` (e-mails, phones, tags) is refused with `CONTACT_MERGE_LIMIT`.
 */
export const MergeContactsBody = z.strictObject({ duplicateId: z.uuid(), version: z.number().int().min(1) });
export type MergeContactsBody = z.infer<typeof MergeContactsBody>;

export const ContactNoteDto = z.strictObject({
  id: z.uuid(),
  contactId: z.uuid(),
  authorUserId: z.uuid().nullable(),
  body: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ContactNoteDto = z.infer<typeof ContactNoteDto>;
export const ContactNotePage = pageOf(ContactNoteDto);
export type ContactNotePage = z.infer<typeof ContactNotePage>;
export const CreateContactNoteBody = z.strictObject({
  body: z.string().trim().min(1).max(CONTACT_LIMITS.noteChars),
});
export type CreateContactNoteBody = z.infer<typeof CreateContactNoteBody>;

// ---- CSV / Excel import ------------------------------------------------------------------------------------------

/** Rows of the upload shown to the mapper, and how many characters of each cell. */
export const CONTACT_IMPORT_PREVIEW = { rows: 5, cellChars: 200, headerChars: 100 } as const;
/** Rows whose problem is reported (row number + code); the rest are only counted. */
export const CONTACT_IMPORT_MAX_ERRORS = 100;

/** A 0-based column of the uploaded sheet. */
const Column = z.number().int().min(0).max(999);

/**
 * Which column feeds which field. `emails` / `phones`: several columns (a cell may also hold several values separated
 * by `;` or `,`); `tags` / `types`: one column of values separated by `;` or `,` (types in English or Spanish:
 * comprador, vendedor, inquilino, propietario). `consentMarketing` / `doNotContact`: yes/no columns
 * (`yes`, `sí`, `true`, `1`, `x`). `note`: added as a note to a new contact.
 */
export const ContactImportMapping = z
  .strictObject({
    firstName: Column.optional(),
    lastName: Column.optional(),
    /** A "full name" column, split on the first space when no first/last name columns are mapped. */
    fullName: Column.optional(),
    emails: z.array(Column).max(5).default([]),
    phones: z.array(Column).max(5).default([]),
    language: Column.optional(),
    tags: Column.optional(),
    types: Column.optional(),
    consentMarketing: Column.optional(),
    doNotContact: Column.optional(),
    note: Column.optional(),
  })
  .refine(
    (m) =>
      m.firstName !== undefined ||
      m.lastName !== undefined ||
      m.fullName !== undefined ||
      m.emails.length > 0 ||
      m.phones.length > 0,
    { message: 'map a name, an e-mail or a phone column', path: ['emails'] },
  );
export type ContactImportMapping = z.infer<typeof ContactImportMapping>;

export const ContactImportStatus = z.enum(['UPLOADED', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'EXPIRED']);
export type ContactImportStatus = z.infer<typeof ContactImportStatus>;
export const ContactImportDuplicateMode = z.enum(['SKIP', 'MERGE']);
export type ContactImportDuplicateMode = z.infer<typeof ContactImportDuplicateMode>;

/** `POST /v1/crm/contact-imports` (raw CSV / XLSX body): the stored upload, its header and first rows. */
export const ContactImportUploadDto = z.strictObject({
  id: z.uuid(),
  kind: z.enum(['csv', 'xlsx']),
  headers: z.array(z.string()),
  /** The first data rows, cells clipped to `CONTACT_IMPORT_PREVIEW.cellChars`. */
  rows: z.array(z.array(z.string())),
  /** A mapping guessed from the header names (the mapper's starting point). */
  suggested: z.record(z.string(), z.union([z.number().int(), z.array(z.number().int())])),
});
export type ContactImportUploadDto = z.infer<typeof ContactImportUploadDto>;

/** `POST /v1/crm/contact-imports/:id/start`: the mapping and the defaults every imported contact gets. */
export const StartContactImportBody = z.strictObject({
  mapping: ContactImportMapping,
  onDuplicate: ContactImportDuplicateMode.default('SKIP'),
  /** Types for rows without a types column (or an empty cell). */
  defaultTypes: z.array(ContactType).max(CONTACT_TYPES.length).default([]),
  /** Tags added to every imported contact (e.g. the campaign or fair). */
  tags: z.array(ContactTag).max(5).default([]),
  phoneCountry: PhoneCountry.default(DEFAULT_PHONE_COUNTRY),
  /** The rows' consent to data processing was collected (recorded now). */
  consentProcessing: z.boolean().default(false),
});
export type StartContactImportBody = z.infer<typeof StartContactImportBody>;
export type StartContactImportInput = z.input<typeof StartContactImportBody>;

export const ContactImportError = z.strictObject({
  /** The spreadsheet row number (1 = the header). */
  row: z.number().int(),
  /** `DUPLICATE_RACE`: an e-mail / phone of the row was taken by another contact while the batch ran (left out). */
  code: z.enum(['NO_IDENTITY', 'INVALID_EMAIL', 'INVALID_PHONE', 'TOO_LONG', 'DUPLICATE_RACE']),
});
export type ContactImportError = z.infer<typeof ContactImportError>;

export const ContactImportDto = z.strictObject({
  id: z.uuid(),
  status: ContactImportStatus,
  kind: z.enum(['csv', 'xlsx']),
  onDuplicate: ContactImportDuplicateMode,
  totalRows: z.number().int(),
  createdCount: z.number().int(),
  mergedCount: z.number().int(),
  skippedCount: z.number().int(),
  invalidCount: z.number().int(),
  errors: z.array(ContactImportError),
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type ContactImportDto = z.infer<typeof ContactImportDto>;
export const ContactImportPage = pageOf(ContactImportDto);
export type ContactImportPage = z.infer<typeof ContactImportPage>;
export const ContactImportParams = z.strictObject({ id: z.uuid() });
