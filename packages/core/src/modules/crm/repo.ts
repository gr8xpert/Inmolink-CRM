import type { Tx } from '@inmolink/db';
import {
  contactEmails,
  contactFacets,
  contactImports,
  contactNotes,
  contactPhones,
  contacts,
} from '@inmolink/db/schema/crm';
import { newId } from '@inmolink/platform/ids';
import { and, eq, gt, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfter, keysetOrder } from '../../pagination';

/**
 * crm queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/crm` — other modules' tables fail `pnpm check:boundaries`.
 */

/** A text[] / uuid[] bind parameter (one parameter, not one per element). */
const textArray = (values: readonly string[]) => sql`${sql.param(values)}::text[]`;
const uuidArray = (values: readonly string[]) => sql`${sql.param(values)}::uuid[]`;

// ---- contacts -----------------------------------------------------------------------------------------------------

/**
 * A contact's e-mails / phones, primary first, as one array column of the row (no extra round trip). The outer
 * columns are written qualified by hand: Drizzle renders a single-table query's columns unqualified, which inside the
 * subquery would name the inner table's `id`.
 */
const emailsOf = sql<string[]>`coalesce((select array_agg(e.email order by e.position, e.created_at, e.id)
  from ${contactEmails} e where e.agency_id = contacts.agency_id and e.contact_id = contacts.id), '{}')`;
const phonesOf = sql<string[]>`coalesce((select array_agg(p.phone order by p.position, p.created_at, p.id)
  from ${contactPhones} p where p.agency_id = contacts.agency_id and p.contact_id = contacts.id), '{}')`;

const contactColumns = {
  id: contacts.id,
  agencyId: contacts.agencyId,
  ownerUserId: contacts.ownerUserId,
  types: contacts.types,
  firstName: contacts.firstName,
  lastName: contacts.lastName,
  language: contacts.language,
  source: contacts.source,
  tags: contacts.tags,
  consentMarketing: contacts.consentMarketing,
  consentMarketingAt: contacts.consentMarketingAt,
  consentProcessing: contacts.consentProcessing,
  consentProcessingAt: contacts.consentProcessingAt,
  doNotContact: contacts.doNotContact,
  version: contacts.version,
  createdAt: contacts.createdAt,
  updatedAt: contacts.updatedAt,
};

export type ContactRow = {
  [K in keyof typeof contactColumns]: (typeof contacts.$inferSelect)[K & keyof typeof contacts.$inferSelect];
} & { emails: string[]; phones: string[] };

/** One open contact with its e-mails and phones (one query); `forUpdate` locks the contact row. */
export async function getContact(tx: Tx, id: string, opts: { forUpdate?: boolean } = {}): Promise<ContactRow | null> {
  const q = tx
    .select({ ...contactColumns, emails: emailsOf, phones: phonesOf })
    .from(contacts)
    .where(and(eq(contacts.id, id), isNull(contacts.deletedAt)));
  const [row] = opts.forUpdate ? await q.for('update', { of: contacts }) : await q;
  return (row as ContactRow | undefined) ?? null;
}

/**
 * Locks and loads the open contacts among `ids` with their e-mails and phones, in one query. Rows are locked in id
 * order, so two merges of the same pair never deadlock.
 */
export async function lockAndLoad(tx: Tx, ids: readonly string[]): Promise<ContactRow[]> {
  const rows = await tx
    .select({ ...contactColumns, emails: emailsOf, phones: phonesOf })
    .from(contacts)
    .where(and(inArray(contacts.id, [...ids]), isNull(contacts.deletedAt)))
    .orderBy(contacts.id)
    .for('update', { of: contacts });
  return rows as ContactRow[];
}

/** The contact a member's earlier `POST` with the same `Idempotency-Key` created, within `since`. */
export async function findByIdempotency(tx: Tx, agencyId: string, hash: string, since: Date): Promise<string | null> {
  const [row] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.agencyId, agencyId),
        eq(contacts.idempotencyHash, hash),
        gt(contacts.createdAt, since),
        isNull(contacts.deletedAt),
      ),
    );
  return row?.id ?? null;
}

export interface ContactListFilter {
  tag?: string;
  type?: string;
  ownerUserId?: string;
}

const listColumns = {
  id: contacts.id,
  types: contacts.types,
  firstName: contacts.firstName,
  lastName: contacts.lastName,
  primaryEmail: contacts.primaryEmail,
  primaryPhone: contacts.primaryPhone,
  tags: contacts.tags,
  doNotContact: contacts.doNotContact,
  ownerUserId: contacts.ownerUserId,
  createdAt: contacts.createdAt,
};
export type ContactListRow = { [K in keyof typeof listColumns]: (typeof contacts.$inferSelect)[K] };

/**
 * The agency's open contacts, newest first (keyset on `contacts_agency_created_idx` / `…_owner_created_idx`); a tag
 * or type filter is a semi-join on `contact_facets_agency_facet_idx` (leakproof `=`, usable under RLS).
 */
export async function listContacts(
  tx: Tx,
  agencyId: string,
  filter: ContactListFilter,
  page: { limit: number; cursor?: KeysetCursor },
): Promise<ContactListRow[]> {
  const where: (SQL | undefined)[] = [
    eq(contacts.agencyId, agencyId),
    isNull(contacts.deletedAt),
    keysetAfter(contacts.createdAt, contacts.id, page.cursor, 'desc'),
  ];
  if (filter.ownerUserId) where.push(eq(contacts.ownerUserId, filter.ownerUserId));
  for (const facet of [filter.tag && `tag:${filter.tag}`, filter.type && `type:${filter.type}`]) {
    if (!facet) continue;
    where.push(
      inArray(
        contacts.id,
        tx
          .select({ id: contactFacets.contactId })
          .from(contactFacets)
          .where(and(eq(contactFacets.agencyId, agencyId), eq(contactFacets.facet, facet))),
      ),
    );
  }
  return tx
    .select(listColumns)
    .from(contacts)
    .where(and(...where))
    .orderBy(...keysetOrder(contacts.createdAt, contacts.id, 'desc'))
    .limit(page.limit + 1);
}

/** Open contacts by id (a lookup's answer; bounded by the caller), newest first. */
export async function listContactsByIds(tx: Tx, agencyId: string, ids: readonly string[]): Promise<ContactListRow[]> {
  if (ids.length === 0) return [];
  return tx
    .select(listColumns)
    .from(contacts)
    .where(and(eq(contacts.agencyId, agencyId), inArray(contacts.id, [...ids]), isNull(contacts.deletedAt)))
    .orderBy(...keysetOrder(contacts.createdAt, contacts.id, 'desc'));
}

export interface IdentifierOwner {
  contactId: string;
  on: 'email' | 'phone';
  value: string;
}

/**
 * Which contacts own any of these e-mails / phones (duplicate detection): one query over the two unique indexes
 * (`agency_id, email` / `agency_id, phone`). Identifiers always belong to an open contact (a merge moves them).
 */
export async function identifierOwners(
  tx: Tx,
  agencyId: string,
  emails: readonly string[],
  phones: readonly string[],
): Promise<IdentifierOwner[]> {
  if (emails.length === 0 && phones.length === 0) return [];
  const res = await tx.execute(sql`
    select contact_id as "contactId", 'email' as "on", email as "value" from ${contactEmails}
      where agency_id = ${agencyId} and email = any(${textArray(emails)})
    union all
    select contact_id, 'phone', phone from ${contactPhones}
      where agency_id = ${agencyId} and phone = any(${textArray(phones)})`);
  return res.rows as unknown as IdentifierOwner[];
}

export type NewContact = Omit<typeof contacts.$inferInsert, 'version' | 'createdAt' | 'updatedAt' | 'deletedAt'>;

/** Inserts contacts (one statement; ≤ 500 per call keeps the bind parameters well under the limit). */
export async function insertContacts(tx: Tx, rows: readonly NewContact[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(contacts).values([...rows]);
}

export interface NewIdentifier {
  contactId: string;
  value: string;
  position: number;
}

/**
 * Adds e-mails and phones (two statements at most). `skipTaken`: an identifier another contact got meanwhile (a
 * concurrent writer) is left out instead of failing — for imports; the answer lists what was inserted, so the caller
 * can report what was left out. Without it a taken identifier fails the statement (23505).
 */
export async function insertIdentifiers(
  tx: Tx,
  agencyId: string,
  emails: readonly NewIdentifier[],
  phones: readonly NewIdentifier[],
  opts: { skipTaken?: boolean } = {},
): Promise<{ emails: Set<string>; phones: Set<string> }> {
  const out = { emails: new Set<string>(), phones: new Set<string>() };
  if (emails.length > 0) {
    const q = tx
      .insert(contactEmails)
      .values(
        emails.map((e) => ({ id: newId(), agencyId, contactId: e.contactId, email: e.value, position: e.position })),
      );
    const rows = await (opts.skipTaken ? q.onConflictDoNothing() : q).returning({ value: contactEmails.email });
    for (const r of rows) out.emails.add(r.value);
  }
  if (phones.length > 0) {
    const q = tx
      .insert(contactPhones)
      .values(
        phones.map((p) => ({ id: newId(), agencyId, contactId: p.contactId, phone: p.value, position: p.position })),
      );
    const rows = await (opts.skipTaken ? q.onConflictDoNothing() : q).returning({ value: contactPhones.phone });
    for (const r of rows) out.phones.add(r.value);
  }
  return out;
}

/**
 * Replaces a contact's e-mails (when `emails` is given) and phones (when `phones` is given) in one statement: the
 * identifiers no longer listed are deleted, the listed ones upserted with their new position. An identifier another
 * contact owns is not taken (the upsert's `where` is false): the answer counts what the contact now holds, and fewer
 * than asked means a concurrent writer took one (the caller refuses the change).
 */
export async function replaceIdentifiers(
  tx: Tx,
  agencyId: string,
  contactId: string,
  emails: readonly string[] | undefined,
  phones: readonly string[] | undefined,
): Promise<{ emails: number; phones: number }> {
  const parts: SQL[] = [];
  const counts: SQL[] = [];
  if (emails) {
    parts.push(sql`de as (delete from ${contactEmails} where agency_id = ${agencyId} and contact_id = ${contactId}
        and not (email = any(${textArray(emails)}))),
      ie as (insert into ${contactEmails} (id, agency_id, contact_id, email, position)
        select u.id, ${agencyId}::uuid, ${contactId}::uuid, u.value, (u.n - 1)::int
          from unnest(${uuidArray(emails.map(() => newId()))}, ${textArray(emails)}) with ordinality as u(id, value, n)
        on conflict (agency_id, email) do update set position = excluded.position
          where ${contactEmails}.contact_id = excluded.contact_id
        returning 1)`);
    counts.push(sql`(select count(*) from ie)::int as emails`);
  } else counts.push(sql`0 as emails`);
  if (phones) {
    parts.push(sql`dp as (delete from ${contactPhones} where agency_id = ${agencyId} and contact_id = ${contactId}
        and not (phone = any(${textArray(phones)}))),
      ip as (insert into ${contactPhones} (id, agency_id, contact_id, phone, position)
        select u.id, ${agencyId}::uuid, ${contactId}::uuid, u.value, (u.n - 1)::int
          from unnest(${uuidArray(phones.map(() => newId()))}, ${textArray(phones)}) with ordinality as u(id, value, n)
        on conflict (agency_id, phone) do update set position = excluded.position
          where ${contactPhones}.contact_id = excluded.contact_id
        returning 1)`);
    counts.push(sql`(select count(*) from ip)::int as phones`);
  } else counts.push(sql`0 as phones`);
  if (parts.length === 0) return { emails: 0, phones: 0 };
  const res = await tx.execute(sql`with ${sql.join(parts, sql`, `)} select ${sql.join(counts, sql`, `)}`);
  return res.rows[0] as { emails: number; phones: number };
}

/**
 * Brings `contact_facets` in step with these contacts' tags and types (one statement): rows for tags / types they no
 * longer have, or for a closed contact, are deleted; missing ones inserted. Every writer of `tags` / `types` calls it
 * in its transaction.
 */
export async function syncFacets(tx: Tx, agencyId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.execute(sql`
    with wanted as (
      select c.id as contact_id, f.facet from ${contacts} c
      cross join lateral (
        select 'tag:' || x as facet from unnest(c.tags) x
        union select 'type:' || y from unnest(c.types) y
      ) f
      where c.agency_id = ${agencyId} and c.id = any(${uuidArray(ids)}) and c.deleted_at is null
    ),
    gone as (
      delete from ${contactFacets} t
      where t.agency_id = ${agencyId} and t.contact_id = any(${uuidArray(ids)})
        and not exists (select 1 from wanted w where w.contact_id = t.contact_id and w.facet = t.facet)
    )
    insert into ${contactFacets} (agency_id, contact_id, facet)
    select ${agencyId}::uuid, contact_id, facet from wanted
    on conflict do nothing`);
}

/** Sets `primary_email` / `primary_phone` of these contacts from their first identifiers (one statement). */
export async function refreshPrimaries(tx: Tx, agencyId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(contacts)
    .set({
      primaryEmail: sql`(select e.email from ${contactEmails} e where e.agency_id = contacts.agency_id
        and e.contact_id = contacts.id order by e.position, e.created_at, e.id limit 1)`,
      primaryPhone: sql`(select p.phone from ${contactPhones} p where p.agency_id = contacts.agency_id
        and p.contact_id = contacts.id order by p.position, p.created_at, p.id limit 1)`,
    })
    .where(and(eq(contacts.agencyId, agencyId), inArray(contacts.id, [...ids])));
}

export async function updateWithVersion(
  tx: Tx,
  id: string,
  version: number,
  patch: Partial<typeof contacts.$inferInsert>,
): Promise<{ id: string; version: number } | null> {
  const [row] = await tx
    .update(contacts)
    .set({ ...patch, version: sql`${contacts.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(contacts.id, id), eq(contacts.version, version), isNull(contacts.deletedAt)))
    .returning({ id: contacts.id, version: contacts.version });
  return row ?? null;
}

/**
 * Details added to an existing contact (a duplicate's create with `mergeInto`, an import row in MERGE mode, the
 * closed side of a merge). Kept: what the contact already has. Added: types and tags (union, order kept, tags capped),
 * names and language where it has none, do-not-contact (once set by either side it stays: the safe reading).
 *
 * Consents (S10-01 review): a recorded choice (`consent_*_at` set) is never overturned by a claim without a time —
 * a form tick or an import default only records consent for a contact who never chose. A choice with a time (the
 * closed side of a merge) replaces the contact's only when it is more recent.
 */
export interface AbsorbPatch {
  contactId: string;
  types: string[];
  tags: string[];
  firstName: string | null;
  lastName: string | null;
  language: string | null;
  consentMarketing: boolean;
  consentMarketingAt: string | null;
  consentProcessing: boolean;
  consentProcessingAt: string | null;
  doNotContact: boolean;
}

const consentValue = (field: string) => {
  const cur = sql.raw(`c.${field}`);
  const curAt = sql.raw(`c.${field}_at`);
  const inc = sql.raw(`p.${field}`);
  const incAt = sql.raw(`p.${field}_at`);
  return {
    value: sql`case when ${incAt} is not null and (${curAt} is null or ${incAt} > ${curAt}) then ${inc}
      when ${incAt} is null and ${curAt} is null and ${inc} then true else ${cur} end`,
    at: sql`case when ${incAt} is not null and (${curAt} is null or ${incAt} > ${curAt}) then ${incAt}
      when ${incAt} is null and ${curAt} is null and ${inc} then now() else ${curAt} end`,
  };
};
const marketing = consentValue('consent_marketing');
const processing = consentValue('consent_processing');

/** Applies absorb patches (one statement for any number of contacts); returns the new versions. */
export async function absorb(
  tx: Tx,
  agencyId: string,
  patches: readonly AbsorbPatch[],
  maxTags: number,
): Promise<{ id: string; version: number }[]> {
  if (patches.length === 0) return [];
  const res = await tx.execute(sql`
    update ${contacts} c set
      types = array(select x from unnest(c.types || p.types) with ordinality u(x, n) group by x order by min(n)),
      tags = (array(select x from unnest(c.tags || p.tags) with ordinality u(x, n) group by x order by min(n)))[1:${maxTags}],
      first_name = coalesce(c.first_name, p.first_name),
      last_name = coalesce(c.last_name, p.last_name),
      language = coalesce(c.language, p.language),
      consent_marketing = ${marketing.value},
      consent_marketing_at = ${marketing.at},
      consent_processing = ${processing.value},
      consent_processing_at = ${processing.at},
      do_not_contact = c.do_not_contact or p.do_not_contact,
      version = c.version + 1,
      updated_at = now()
    from jsonb_to_recordset(${JSON.stringify(patches.map(toRecord))}::jsonb) as p(
      contact_id uuid, types text[], tags text[], first_name text, last_name text, language text,
      consent_marketing boolean, consent_marketing_at timestamptz, consent_processing boolean,
      consent_processing_at timestamptz, do_not_contact boolean)
    where c.id = p.contact_id and c.agency_id = ${agencyId} and c.deleted_at is null
    returning c.id, c.version`);
  return res.rows as { id: string; version: number }[];
}

const toRecord = (p: AbsorbPatch) => ({
  contact_id: p.contactId,
  types: p.types,
  tags: p.tags,
  first_name: p.firstName,
  last_name: p.lastName,
  language: p.language,
  consent_marketing: p.consentMarketing,
  consent_marketing_at: p.consentMarketingAt,
  consent_processing: p.consentProcessing,
  consent_processing_at: p.consentProcessingAt,
  do_not_contact: p.doNotContact,
});

// ---- merge --------------------------------------------------------------------------------------------------------

/**
 * Every crm table that points at a contact. A merge moves their rows from the closed contact to the survivor in its
 * own transaction — all of them in one statement (`repointReferences`), whatever their number. **S10-02 (leads),
 * S10-04 (activities) and S10-05 (tasks) add their table here** (`contacts.int.test.ts` fails on a crm table with a
 * `contact_id` column that is missing); modules outside crm (registrations, `property_privates`) react to
 * `crm.contact.merged` instead (events.ts).
 */
export const CONTACT_REFERENCES = [{ name: 'contact_notes', table: contactNotes }] as const;

/** Moves every reference of `fromId` to `toId` (one statement); returns the rows moved per table. */
export async function repointReferences(
  tx: Tx,
  agencyId: string,
  fromId: string,
  toId: string,
): Promise<Record<string, number>> {
  const ctes = CONTACT_REFERENCES.map(
    (ref, i) => sql`${sql.raw(`r${i}`)} as (update ${ref.table} set contact_id = ${toId}
      where agency_id = ${agencyId} and contact_id = ${fromId} returning 1)`,
  );
  const counts = CONTACT_REFERENCES.map(
    (ref, i) => sql`(select count(*) from ${sql.raw(`r${i}`)})::int as ${sql.identifier(ref.name)}`,
  );
  const res = await tx.execute(sql`with ${sql.join(ctes, sql`, `)} select ${sql.join(counts, sql`, `)}`);
  return res.rows[0] as Record<string, number>;
}

/**
 * Moves the closed contact's e-mails and phones to the survivor, after the survivor's own (one statement). They
 * cannot collide: an identifier belongs to one contact per agency.
 */
export async function moveIdentifiers(tx: Tx, agencyId: string, fromId: string, toId: string): Promise<void> {
  await tx.execute(sql`
    with e as (update ${contactEmails} set contact_id = ${toId}, position = position + 1000
        where agency_id = ${agencyId} and contact_id = ${fromId} returning 1),
      p as (update ${contactPhones} set contact_id = ${toId}, position = position + 1000
        where agency_id = ${agencyId} and contact_id = ${fromId} returning 1)
    select (select count(*) from e) as emails, (select count(*) from p) as phones`);
}

/**
 * Closes a merged contact and points the contacts merged into it earlier at the survivor (flat chains), in one
 * statement.
 */
export async function closeMerged(tx: Tx, agencyId: string, mergedId: string, survivorId: string): Promise<void> {
  await tx.execute(sql`
    update ${contacts} set
      merged_into_id = ${survivorId},
      deleted_at = case when id = ${mergedId} then now() else deleted_at end,
      primary_email = case when id = ${mergedId} then null else primary_email end,
      primary_phone = case when id = ${mergedId} then null else primary_phone end,
      version = case when id = ${mergedId} then version + 1 else version end,
      updated_at = now()
    where agency_id = ${agencyId} and (id = ${mergedId} or merged_into_id = ${mergedId})`);
}

// ---- notes --------------------------------------------------------------------------------------------------------

const noteColumns = {
  id: contactNotes.id,
  contactId: contactNotes.contactId,
  authorUserId: contactNotes.authorUserId,
  body: contactNotes.body,
  createdAt: contactNotes.createdAt,
  updatedAt: contactNotes.updatedAt,
};
export type NoteRow = { [K in keyof typeof noteColumns]: (typeof contactNotes.$inferSelect)[K] };

export async function insertNotes(
  tx: Tx,
  rows: readonly { agencyId: string; contactId: string; authorUserId: string | null; body: string }[],
): Promise<NoteRow[]> {
  if (rows.length === 0) return [];
  return tx
    .insert(contactNotes)
    .values(rows.map((r) => ({ id: newId(), ...r })))
    .returning(noteColumns);
}

/** A contact's notes, newest first (keyset on `contact_notes_contact_created_idx`). */
export async function listNotes(
  tx: Tx,
  agencyId: string,
  contactId: string,
  page: { limit: number; cursor?: KeysetCursor },
): Promise<NoteRow[]> {
  return tx
    .select(noteColumns)
    .from(contactNotes)
    .where(
      and(
        eq(contactNotes.agencyId, agencyId),
        eq(contactNotes.contactId, contactId),
        keysetAfter(contactNotes.createdAt, contactNotes.id, page.cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrder(contactNotes.createdAt, contactNotes.id, 'desc'))
    .limit(page.limit + 1);
}

// ---- imports ------------------------------------------------------------------------------------------------------

const importColumns = {
  id: contactImports.id,
  agencyId: contactImports.agencyId,
  createdBy: contactImports.createdBy,
  status: contactImports.status,
  fileKind: contactImports.fileKind,
  headers: contactImports.headers,
  mapping: contactImports.mapping,
  onDuplicate: contactImports.onDuplicate,
  totalRows: contactImports.totalRows,
  processedRows: contactImports.processedRows,
  createdCount: contactImports.createdCount,
  mergedCount: contactImports.mergedCount,
  skippedCount: contactImports.skippedCount,
  invalidCount: contactImports.invalidCount,
  errors: contactImports.errors,
  errorCode: contactImports.errorCode,
  createdAt: contactImports.createdAt,
  startedAt: contactImports.startedAt,
  finishedAt: contactImports.finishedAt,
};
export type ImportRow = { [K in keyof typeof importColumns]: (typeof contactImports.$inferSelect)[K] };

export async function insertImport(tx: Tx, row: typeof contactImports.$inferInsert): Promise<void> {
  await tx.insert(contactImports).values(row);
}

export async function getImport(tx: Tx, id: string, opts: { forUpdate?: boolean } = {}): Promise<ImportRow | null> {
  const q = tx.select(importColumns).from(contactImports).where(eq(contactImports.id, id));
  const [row] = opts.forUpdate ? await q.for('update') : await q;
  return row ?? null;
}

export async function listImports(
  tx: Tx,
  agencyId: string,
  page: { limit: number; cursor?: KeysetCursor },
): Promise<ImportRow[]> {
  return tx
    .select(importColumns)
    .from(contactImports)
    .where(
      and(
        eq(contactImports.agencyId, agencyId),
        keysetAfter(contactImports.createdAt, contactImports.id, page.cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrder(contactImports.createdAt, contactImports.id, 'desc'))
    .limit(page.limit + 1);
}

export async function updateImport(
  tx: Tx,
  id: string,
  patch: Partial<typeof contactImports.$inferInsert>,
): Promise<void> {
  await tx
    .update(contactImports)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(contactImports.id, id));
}

/** A batch's outcome added to the run (its checkpoint moves in the same transaction as the batch's rows). */
export async function addImportProgress(
  tx: Tx,
  id: string,
  delta: {
    processedRows: number;
    created: number;
    merged: number;
    skipped: number;
    invalid: number;
    errors: readonly { row: number; code: string }[];
  },
  maxErrors: number,
): Promise<void> {
  await tx
    .update(contactImports)
    .set({
      processedRows: delta.processedRows,
      totalRows: delta.processedRows,
      createdCount: sql`${contactImports.createdCount} + ${delta.created}`,
      mergedCount: sql`${contactImports.mergedCount} + ${delta.merged}`,
      skippedCount: sql`${contactImports.skippedCount} + ${delta.skipped}`,
      invalidCount: sql`${contactImports.invalidCount} + ${delta.invalid}`,
      errors:
        delta.errors.length === 0
          ? sql`${contactImports.errors}`
          : sql`(select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(
              ${contactImports.errors} || ${JSON.stringify(delta.errors)}::jsonb) e limit ${maxErrors}) s)`,
      updatedAt: sql`now()`,
    })
    .where(eq(contactImports.id, id));
}

/**
 * Files the sweep deletes (system role, every agency; on `contact_imports_file_idx`): uploads never started, created
 * before `uploadedBefore`, and finished runs (succeeded, failed, expired) whose delete did not happen, finished before
 * `finishedBefore`. Uploads among them are expired in the same transaction (`expireImports`).
 */
export async function filesToSweep(
  tx: Tx,
  uploadedBefore: Date,
  finishedBefore: Date,
  limit: number,
): Promise<{ id: string; agencyId: string; status: string }[]> {
  const latest = uploadedBefore > finishedBefore ? uploadedBefore : finishedBefore;
  const res = await tx.execute(sql`
    select id, agency_id as "agencyId", status from ${contactImports}
    where file_deleted_at is null and created_at < ${latest.toISOString()}::timestamptz
      and ((status = 'UPLOADED' and created_at < ${uploadedBefore.toISOString()}::timestamptz)
        or (status in ('SUCCEEDED', 'FAILED', 'EXPIRED')
          and coalesce(finished_at, created_at) < ${finishedBefore.toISOString()}::timestamptz))
    order by created_at
    limit ${limit}
    for update skip locked`);
  return res.rows as { id: string; agencyId: string; status: string }[];
}

export async function expireImports(tx: Tx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(contactImports)
    .set({ status: 'EXPIRED', finishedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(inArray(contactImports.id, [...ids]), eq(contactImports.status, 'UPLOADED')));
}

/** The files of these imports are gone from storage. */
export async function markFilesDeleted(tx: Tx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(contactImports)
    .set({ fileDeletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(inArray(contactImports.id, [...ids]));
}
