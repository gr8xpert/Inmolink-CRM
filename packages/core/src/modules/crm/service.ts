import {
  AppError,
  CONTACT_LIMITS,
  type ContactDto,
  type ContactDuplicateMatch,
  type ContactListItemDto,
  type ContactLookupBody,
  type ContactLookupDto,
  type ContactNoteDto,
  type ContactNotePage,
  type ContactPage,
  type ContactSource,
  type ContactType,
  type CreateContactBody,
  type CreateContactNoteBody,
  DEFAULT_PHONE_COUNTRY,
  type ListContactsQuery,
  type MergeContactsBody,
  type PageQuery,
  type UpdateContactBody,
} from '@inmolink/contracts';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { type Ctx, userIdOf } from '../../context';
import { idempotencyHashOf, idempotencyWindowStart, isUniqueViolation } from '../../idempotency';
import { decodeCursor, toPage } from '../../pagination';
import * as billing from '../billing';
import * as compliance from '../compliance';
import * as identity from '../identity';
import { recordNoteAdded } from './activities';
import { auditImpersonatedRead } from './audit';
import { crmEvents } from './events';
import { distinct, normalizeEmail, normalizePhone } from './normalize';
import { assertCan } from './policy';
import * as repo from './repo';

/**
 * Contacts (S10-01): create with duplicate detection on e-mail and phone (a duplicate is refused with the matches, and
 * the client offers the merge), update, merge two contacts, notes, lookup. Contacts are PII: nothing here logs a value.
 *
 * Phones without an international prefix are read with `DEFAULT_PHONE_COUNTRY` (ES) unless the request names a
 * country: agencies have no country setting yet (S10-01 review: revisit when agency settings get one).
 */

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toContactDto(row: repo.ContactRow): ContactDto {
  return {
    id: row.id,
    types: row.types as ContactType[],
    firstName: row.firstName,
    lastName: row.lastName,
    emails: row.emails,
    phones: row.phones,
    language: row.language,
    source: row.source as ContactSource,
    tags: row.tags,
    consentMarketing: row.consentMarketing,
    consentMarketingAt: iso(row.consentMarketingAt),
    consentProcessing: row.consentProcessing,
    consentProcessingAt: iso(row.consentProcessingAt),
    doNotContact: row.doNotContact,
    ownerUserId: row.ownerUserId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toListItem(row: repo.ContactListRow): ContactListItemDto {
  return {
    id: row.id,
    types: row.types as ContactType[],
    firstName: row.firstName,
    lastName: row.lastName,
    primaryEmail: row.primaryEmail,
    primaryPhone: row.primaryPhone,
    tags: row.tags,
    doNotContact: row.doNotContact,
    ownerUserId: row.ownerUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

function toNoteDto(row: repo.NoteRow): ContactNoteDto {
  return {
    id: row.id,
    contactId: row.contactId,
    authorUserId: row.authorUserId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** E-mails as stored (distinct); one that is not an address is the caller's error. */
function emailsOf(raw: readonly string[]): string[] {
  return distinct(
    raw.map((value, index) => {
      const email = normalizeEmail(value);
      if (!email) throw new AppError('VALIDATION_FAILED', { field: 'emails', index });
      return email;
    }),
  );
}

/** Phones in E.164 (distinct); one that is not a valid number is `CONTACT_PHONE_INVALID` with its index. */
function phonesOf(raw: readonly string[], country: string): string[] {
  return distinct(
    raw.map((value, index) => {
      const phone = normalizePhone(value, country);
      if (!phone) throw new AppError('CONTACT_PHONE_INVALID', { index });
      return phone;
    }),
  );
}

/** The duplicate check's answer: one entry per contact and kind of match (never the matched values themselves). */
function matchesOf(owners: readonly repo.IdentifierOwner[]): ContactDuplicateMatch[] {
  const seen = new Set<string>();
  const out: ContactDuplicateMatch[] = [];
  for (const o of owners) {
    const key = `${o.contactId}:${o.on}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ contactId: o.contactId, on: o.on });
  }
  return out;
}

const IDENTIFIER_CONSTRAINTS = new Set(['contact_emails_agency_email_uq', 'contact_phones_agency_phone_uq']);

/** A concurrent writer took an e-mail / phone (or the idempotency key) between the check and the insert. */
async function withDuplicateGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
    if (cause?.code === '23505' && IDENTIFIER_CONSTRAINTS.has(cause.constraint ?? '')) {
      throw new AppError('CONTACT_DUPLICATE', { matches: [] });
    }
    if (isUniqueViolation(err, 'contacts_idempotency_uq')) throw new AppError('IDEMPOTENCY_KEY_REUSED');
    throw err;
  }
}

/** The responsible agent must be an active member of the agency (S10-01 review). */
async function assertOwner(ctx: Ctx, ownerUserId: string | null | undefined): Promise<void> {
  if (!ownerUserId || ownerUserId === userIdOf(ctx)) return;
  if (!(await identity.isActiveMember(ctx, ownerUserId))) {
    throw new AppError('VALIDATION_FAILED', { field: 'ownerUserId', reason: 'not_a_member' });
  }
}

/** Refuses a contact that would hold more e-mails, phones or tags than `CONTACT_LIMITS` after a merge. */
function assertWithinLimits(emails: number, phones: number, tags: number): void {
  if (emails > CONTACT_LIMITS.emails) throw new AppError('CONTACT_MERGE_LIMIT', { field: 'emails' });
  if (phones > CONTACT_LIMITS.phones) throw new AppError('CONTACT_MERGE_LIMIT', { field: 'phones' });
  if (tags > CONTACT_LIMITS.tags) throw new AppError('CONTACT_MERGE_LIMIT', { field: 'tags' });
}

async function loadContact(ctx: Ctx, id: string): Promise<ContactDto> {
  const row = await repo.getContact(ctx.tx, id);
  if (!row) throw new AppError('CONTACT_NOT_FOUND');
  assertCan(ctx, 'crm.contacts.read', row);
  return toContactDto(row);
}

/** A create's outcome: a new contact, the details added to an existing one (`mergeInto`), or a replayed retry. */
export interface CreateContactResult {
  contact: ContactDto;
  outcome: 'CREATED' | 'MERGED' | 'REPLAYED';
}

/**
 * `POST /v1/crm/contacts`. An e-mail or phone that already belongs to a contact refuses the create with
 * `CONTACT_DUPLICATE` and the matching contacts — never a second contact for the same person. With `mergeInto` (one
 * of those matches) the new details are added to that contact instead (`absorb`). With an `Idempotency-Key`, a retry
 * by the same member within 24 h answers the contact the first request created.
 */
export async function createContact(
  ctx: Ctx,
  input: CreateContactBody,
  opts: { idempotencyKey?: string } = {},
): Promise<CreateContactResult> {
  assertCan(ctx, 'crm.contacts.write');
  const agencyId = ctx.tenant.agencyId;
  const idempotencyHash = idempotencyHashOf('crm.contact', userIdOf(ctx), opts.idempotencyKey);
  if (idempotencyHash) {
    const replayed = await repo.findByIdempotency(ctx.tx, agencyId, idempotencyHash, idempotencyWindowStart());
    if (replayed) return { contact: await loadContact(ctx, replayed), outcome: 'REPLAYED' };
  }
  const emails = emailsOf(input.emails);
  const phones = phonesOf(input.phones, input.phoneCountry ?? DEFAULT_PHONE_COUNTRY);
  const owners = await repo.identifierOwners(ctx.tx, agencyId, emails, phones);

  if (input.mergeInto) {
    return { contact: await mergeInto(ctx, input, input.mergeInto, emails, phones, owners), outcome: 'MERGED' };
  }
  if (owners.length > 0) throw new AppError('CONTACT_DUPLICATE', { matches: matchesOf(owners) });
  await assertOwner(ctx, input.ownerUserId);
  // S13-F21: Free's CRM holds 100 contacts (PLAN §11); counted only when the plan has a limit (merges add none).
  await billing.requireQuota(ctx, 'crm_contacts', (limit) => repo.countLiveContactsUpTo(ctx.tx, agencyId, limit));

  const id = newId();
  const now = new Date();
  await withDuplicateGuard(async () => {
    await repo.insertContacts(ctx.tx, [
      {
        id,
        agencyId,
        ownerUserId: input.ownerUserId === undefined ? userIdOf(ctx) : input.ownerUserId,
        types: distinct(input.types),
        firstName: input.firstName,
        lastName: input.lastName,
        primaryEmail: emails[0] ?? null,
        primaryPhone: phones[0] ?? null,
        language: input.language,
        source: input.source,
        tags: distinct(input.tags),
        consentMarketing: input.consentMarketing,
        consentMarketingAt: input.consentMarketing ? now : null,
        consentProcessing: input.consentProcessing,
        consentProcessingAt: input.consentProcessing ? now : null,
        doNotContact: input.doNotContact,
        idempotencyHash,
      },
    ]);
    await repo.insertIdentifiers(
      ctx.tx,
      agencyId,
      emails.map((value, position) => ({ contactId: id, value, position })),
      phones.map((value, position) => ({ contactId: id, value, position })),
    );
  });
  await repo.syncFacets(ctx.tx, agencyId, [id]);
  await emit(ctx.tx, crmEvents.contactCreated({ agencyId, contactId: id, source: input.source }));
  return { contact: await loadContact(ctx, id), outcome: 'CREATED' };
}

/** The create's merge path: the form's details added to the existing contact the duplicate check named. */
async function mergeInto(
  ctx: Ctx,
  input: CreateContactBody,
  targetId: string,
  emails: string[],
  phones: string[],
  owners: repo.IdentifierOwner[],
): Promise<ContactDto> {
  assertCan(ctx, 'crm.contacts.merge');
  const agencyId = ctx.tenant.agencyId;
  // Only a contact the check named: `mergeInto` is "these details are that person", not a free re-assignment.
  if (!owners.some((o) => o.contactId === targetId)) throw new AppError('CONTACT_MERGE_INVALID');
  const others = owners.filter((o) => o.contactId !== targetId);
  if (others.length > 0) throw new AppError('CONTACT_DUPLICATE', { matches: matchesOf(others) });
  const target = await repo.getContact(ctx.tx, targetId, { forUpdate: true });
  if (!target) throw new AppError('CONTACT_NOT_FOUND');
  assertCan(ctx, 'crm.contacts.merge', target);

  const newEmails = emails.filter((e) => !target.emails.includes(e));
  const newPhones = phones.filter((p) => !target.phones.includes(p));
  assertWithinLimits(
    target.emails.length + newEmails.length,
    target.phones.length + newPhones.length,
    distinct([...target.tags, ...input.tags]).length,
  );
  const [updated] = await repo.absorb(
    ctx.tx,
    agencyId,
    [
      {
        contactId: targetId,
        types: distinct(input.types),
        tags: distinct(input.tags),
        firstName: input.firstName,
        lastName: input.lastName,
        language: input.language,
        // A form tick is a claim without a time: it records consent only for a contact who never chose.
        consentMarketing: input.consentMarketing,
        consentMarketingAt: null,
        consentProcessing: input.consentProcessing,
        consentProcessingAt: null,
        doNotContact: input.doNotContact,
      },
    ],
    CONTACT_LIMITS.tags,
  );
  await withDuplicateGuard(() =>
    repo.insertIdentifiers(
      ctx.tx,
      agencyId,
      newEmails.map((value, i) => ({ contactId: targetId, value, position: target.emails.length + i })),
      newPhones.map((value, i) => ({ contactId: targetId, value, position: target.phones.length + i })),
    ),
  );
  await repo.refreshPrimaries(ctx.tx, agencyId, [targetId]);
  await repo.syncFacets(ctx.tx, agencyId, [targetId]);
  await emit(
    ctx.tx,
    crmEvents.contactUpdated({ agencyId, contactId: targetId, version: updated?.version ?? target.version + 1 }),
  );
  return loadContact(ctx, targetId);
}

export async function getContact(ctx: Ctx, id: string): Promise<ContactDto> {
  assertCan(ctx, 'crm.contacts.read');
  const contact = await loadContact(ctx, id);
  await auditImpersonatedRead(ctx, 'contacts', { target: { type: 'contact', id } });
  return contact;
}

/** `GET /v1/crm/contacts`: newest first, keyset (≤ 100 per page, one query); filters by tag, type and owner. */
export async function listContacts(ctx: Ctx, query: ListContactsQuery): Promise<ContactPage> {
  assertCan(ctx, 'crm.contacts.read');
  const cursor = decodeCursor(query.cursor);
  const filter: repo.ContactListFilter = {};
  if (query.tag) filter.tag = query.tag;
  if (query.type) filter.type = query.type;
  if (query.owner) {
    const owner = query.owner === 'me' ? userIdOf(ctx) : query.owner;
    if (owner) filter.ownerUserId = owner;
  }
  const rows = await repo.listContacts(
    ctx.tx,
    ctx.tenant.agencyId,
    filter,
    cursor ? { limit: query.limit, cursor } : { limit: query.limit },
  );
  const page = toPage(rows, query.limit, (r) => ({ at: r.createdMs, id: r.id }), toListItem);
  await auditImpersonatedRead(ctx, 'contacts', { count: page.items.length });
  return page;
}

/**
 * `POST /v1/crm/contacts/lookup`: the contacts owning any of these e-mails / phones (exact, normalized; two queries).
 * A phone that is no valid number matches nothing rather than failing the lookup.
 */
export async function lookupContacts(ctx: Ctx, input: ContactLookupBody): Promise<ContactLookupDto> {
  assertCan(ctx, 'crm.contacts.read');
  const country = input.phoneCountry ?? DEFAULT_PHONE_COUNTRY;
  const emails = distinct(input.emails.map(normalizeEmail).filter((e): e is string => e !== null));
  const phones = distinct(input.phones.map((p) => normalizePhone(p, country)).filter((p): p is string => p !== null));
  const owners = await repo.identifierOwners(ctx.tx, ctx.tenant.agencyId, emails, phones);
  const rows = await repo.listContactsByIds(ctx.tx, ctx.tenant.agencyId, distinct(owners.map((o) => o.contactId)));
  await auditImpersonatedRead(ctx, 'contacts', { count: rows.length });
  return { items: rows.map(toListItem), matches: matchesOf(owners) };
}

/**
 * `PATCH /v1/crm/contacts/:id` (optimistic concurrency on `version`; ≤ 8 statements). New e-mails / phones are checked
 * like a create: one that belongs to another contact refuses the change with `CONTACT_DUPLICATE` (merge instead).
 */
export async function updateContact(ctx: Ctx, id: string, input: UpdateContactBody): Promise<ContactDto> {
  const current = await repo.getContact(ctx.tx, id, { forUpdate: true });
  if (!current) throw new AppError('CONTACT_NOT_FOUND');
  assertCan(ctx, 'crm.contacts.write', current);
  if (current.version !== input.version) throw new AppError('VERSION_CONFLICT');
  const agencyId = current.agencyId;
  const emails = input.emails ? emailsOf(input.emails) : undefined;
  const phones = input.phones ? phonesOf(input.phones, input.phoneCountry ?? DEFAULT_PHONE_COUNTRY) : undefined;
  if (emails || phones) {
    const owners = (await repo.identifierOwners(ctx.tx, agencyId, emails ?? [], phones ?? [])).filter(
      (o) => o.contactId !== id,
    );
    if (owners.length > 0) throw new AppError('CONTACT_DUPLICATE', { matches: matchesOf(owners) });
  }
  if (input.ownerUserId !== undefined) await assertOwner(ctx, input.ownerUserId);

  const now = new Date();
  const patch: Parameters<typeof repo.updateWithVersion>[3] = {};
  if (input.types) patch.types = distinct(input.types);
  if (input.firstName !== undefined) patch.firstName = input.firstName;
  if (input.lastName !== undefined) patch.lastName = input.lastName;
  if (input.language !== undefined) patch.language = input.language;
  if (input.source) patch.source = input.source;
  if (input.tags) patch.tags = distinct(input.tags);
  if (input.ownerUserId !== undefined) patch.ownerUserId = input.ownerUserId;
  if (input.doNotContact !== undefined) patch.doNotContact = input.doNotContact;
  // A consent's time is when it last changed (given or withdrawn).
  if (input.consentMarketing !== undefined && input.consentMarketing !== current.consentMarketing) {
    patch.consentMarketing = input.consentMarketing;
    patch.consentMarketingAt = now;
  }
  if (input.consentProcessing !== undefined && input.consentProcessing !== current.consentProcessing) {
    patch.consentProcessing = input.consentProcessing;
    patch.consentProcessingAt = now;
  }
  if (emails) patch.primaryEmail = emails[0] ?? null;
  if (phones) patch.primaryPhone = phones[0] ?? null;

  const updated = await repo.updateWithVersion(ctx.tx, id, input.version, patch);
  if (!updated) throw new AppError('VERSION_CONFLICT');
  if (emails || phones) {
    const held = await repo.replaceIdentifiers(ctx.tx, agencyId, id, emails, phones);
    // fewer than asked: another contact took one since the check (the upsert does not steal it)
    if ((emails && held.emails < emails.length) || (phones && held.phones < phones.length)) {
      throw new AppError('CONTACT_DUPLICATE', { matches: [] });
    }
  }
  if (input.tags || input.types) await repo.syncFacets(ctx.tx, agencyId, [id]);
  await emit(ctx.tx, crmEvents.contactUpdated({ agencyId, contactId: id, version: updated.version }));
  return loadContact(ctx, id);
}

/**
 * `POST /v1/crm/contacts/:id/merge`: `duplicateId` is merged into the contact of the path (the survivor, at
 * `version`), in one transaction and a fixed number of statements (≤ 9, whatever `CONTACT_REFERENCES` holds):
 *  1. both rows are locked and loaded in one query (id order: two merges of the same pair never deadlock);
 *  2. a result over `CONTACT_LIMITS` is refused (`CONTACT_MERGE_LIMIT`);
 *  3. the duplicate's e-mails and phones move to the survivor, after its own (one statement);
 *  4. every crm row pointing at the duplicate moves (`repo.CONTACT_REFERENCES`, one statement: notes, leads and
 *     activities; tasks when S10-05 registers theirs);
 *  5. the survivor takes what it lacks (types, tags, names, language, the more recent consent, do-not-contact);
 *  6. the duplicate is closed (`merged_into_id`, `deleted_at`) and `crm.contact.merged` is emitted, so modules outside
 *     crm (registrations, a listing's seller contact) move their references too.
 */
export async function mergeContacts(ctx: Ctx, survivorId: string, input: MergeContactsBody): Promise<ContactDto> {
  assertCan(ctx, 'crm.contacts.merge');
  if (survivorId === input.duplicateId) throw new AppError('CONTACT_MERGE_INVALID');
  const agencyId = ctx.tenant.agencyId;
  const rows = await repo.lockAndLoad(ctx.tx, [survivorId, input.duplicateId]);
  const survivor = rows.find((r) => r.id === survivorId);
  const duplicate = rows.find((r) => r.id === input.duplicateId);
  if (!survivor || !duplicate) throw new AppError('CONTACT_NOT_FOUND');
  assertCan(ctx, 'crm.contacts.merge', survivor);
  assertCan(ctx, 'crm.contacts.merge', duplicate);
  if (survivor.version !== input.version) throw new AppError('VERSION_CONFLICT');
  assertWithinLimits(
    survivor.emails.length + duplicate.emails.length,
    survivor.phones.length + duplicate.phones.length,
    distinct([...survivor.tags, ...duplicate.tags]).length,
  );

  await repo.moveIdentifiers(ctx.tx, agencyId, duplicate.id, survivor.id);
  await repo.repointReferences(ctx.tx, agencyId, duplicate.id, survivor.id);
  const [updated] = await repo.absorb(
    ctx.tx,
    agencyId,
    [
      {
        contactId: survivor.id,
        types: duplicate.types,
        tags: duplicate.tags,
        firstName: duplicate.firstName,
        lastName: duplicate.lastName,
        language: duplicate.language,
        consentMarketing: duplicate.consentMarketing,
        consentMarketingAt: iso(duplicate.consentMarketingAt),
        consentProcessing: duplicate.consentProcessing,
        consentProcessingAt: iso(duplicate.consentProcessingAt),
        doNotContact: duplicate.doNotContact,
      },
    ],
    CONTACT_LIMITS.tags,
  );
  await repo.closeMerged(ctx.tx, agencyId, duplicate.id, survivor.id);
  await repo.refreshPrimaries(ctx.tx, agencyId, [survivor.id]);
  await repo.syncFacets(ctx.tx, agencyId, [survivor.id, duplicate.id]);
  await compliance.audit(ctx, 'crm.contact.merged', { type: 'contact', id: survivor.id }, { mergedId: duplicate.id });
  await emit(ctx.tx, [
    crmEvents.contactMerged({ agencyId, survivorId: survivor.id, mergedId: duplicate.id }),
    crmEvents.contactUpdated({
      agencyId,
      contactId: survivor.id,
      version: updated?.version ?? survivor.version + 1,
    }),
  ]);
  return loadContact(ctx, survivor.id);
}

// ---- notes --------------------------------------------------------------------------------------------------------

/** `POST /v1/crm/contacts/:id/notes`. */
export async function addContactNote(
  ctx: Ctx,
  contactId: string,
  input: CreateContactNoteBody,
): Promise<ContactNoteDto> {
  assertCan(ctx, 'crm.contacts.write');
  const contact = await repo.getContact(ctx.tx, contactId);
  if (!contact) throw new AppError('CONTACT_NOT_FOUND');
  assertCan(ctx, 'crm.contacts.write', contact);
  const [note] = await repo.insertNotes(ctx.tx, [
    { agencyId: contact.agencyId, contactId, authorUserId: userIdOf(ctx), body: input.body },
  ]);
  if (!note) throw new AppError('CONTACT_NOT_FOUND');
  await recordNoteAdded(ctx.tx, { ...note, agencyId: contact.agencyId });
  return toNoteDto(note);
}

/** `GET /v1/crm/contacts/:id/notes`: newest first, keyset. */
export async function listContactNotes(ctx: Ctx, contactId: string, query: PageQuery): Promise<ContactNotePage> {
  assertCan(ctx, 'crm.contacts.read');
  const cursor = decodeCursor(query.cursor);
  const contact = await repo.getContact(ctx.tx, contactId);
  if (!contact) throw new AppError('CONTACT_NOT_FOUND');
  assertCan(ctx, 'crm.contacts.read', contact);
  const rows = await repo.listNotes(
    ctx.tx,
    contact.agencyId,
    contactId,
    cursor ? { limit: query.limit, cursor } : { limit: query.limit },
  );
  const page = toPage(rows, query.limit, (r) => ({ at: r.createdAt, id: r.id, atUs: r.atUs }), toNoteDto);
  await auditImpersonatedRead(ctx, 'contactNotes', { count: page.items.length, parentId: contactId });
  return page;
}
