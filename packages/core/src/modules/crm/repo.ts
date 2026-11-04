import type { Tx } from '@inmolink/db';
import {
  activities,
  calendarEventAttendees,
  calendarEvents,
  contactEmails,
  contactFacets,
  contactImports,
  contactNotes,
  contactPhones,
  contacts,
  leads,
  sellerProspects,
  tasks,
} from '@inmolink/db/schema/crm';
import { newId } from '@inmolink/platform/ids';
import { and, eq, gt, inArray, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfterRaw, keysetOrderRaw, keysetStamp, rowAfter, rowOrder } from '../../pagination';

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
  createdMs: contacts.createdMs,
};
export type ContactListRow = { [K in keyof typeof listColumns]: (typeof contacts.$inferSelect)[K] };

/**
 * The agency's open contacts, newest first (keyset on `contacts_agency_created_idx` / `…_owner_created_idx`, the
 * cursor a row comparison on the stored `created_ms`: an index condition under RLS, S10-02 review); a tag or type
 * filter is a semi-join on `contact_facets_agency_facet_idx` (leakproof `=`, usable under RLS).
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
    rowAfter(contacts.createdMs, contacts.id, page.cursor),
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
    .orderBy(...rowOrder(contacts.createdMs, contacts.id))
    .limit(page.limit + 1);
}

/** Open contacts by id (a lookup's answer; bounded by the caller), newest first. */
export async function listContactsByIds(tx: Tx, agencyId: string, ids: readonly string[]): Promise<ContactListRow[]> {
  if (ids.length === 0) return [];
  return tx
    .select(listColumns)
    .from(contacts)
    .where(and(eq(contacts.agencyId, agencyId), inArray(contacts.id, [...ids]), isNull(contacts.deletedAt)))
    .orderBy(...rowOrder(contacts.createdMs, contacts.id));
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

/** S17-F29: of these contacts, those who have chosen on marketing (an import's yes does not change their choice). */
export async function contactsWithMarketingChoice(
  tx: Tx,
  agencyId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(eq(contacts.agencyId, agencyId), inArray(contacts.id, [...ids]), isNotNull(contacts.consentMarketingAt)),
    );
  return new Set(rows.map((r) => r.id));
}

export type NewContact = Omit<typeof contacts.$inferInsert, 'version' | 'createdAt' | 'updatedAt' | 'deletedAt'>;

/**
 * S13 review: the agency's contact-quota lock (transaction-scoped advisory lock). Every quota-checked contact create —
 * `createContact`, `startContactImport` and each import batch — takes it before counting (`contactQuotaUsed`), so two
 * creates cannot both take the last place: the second waits for the first's commit, and its count (a new statement,
 * read committed) sees the first's contacts.
 */
export async function lockContactQuota(tx: Tx, agencyId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`crm.contactQuota:${agencyId}`}, 0))`);
}

/**
 * S13-F21: the agency's live contacts, counted up to `cap` (the plan quota: a capped count stops there). Takes no lock:
 * quota checks go through `contactQuotaUsed`. Uses `contacts_agency_created_idx` (partial: live contacts).
 */
export async function countLiveContactsUpTo(tx: Tx, agencyId: string, cap: number): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from (
      select 1 from ${contacts} where ${contacts.agencyId} = ${agencyId}::uuid and ${contacts.deletedAt} is null
      limit ${cap + 1}
    ) t`);
  return rows.rows[0]?.n ?? 0;
}

/**
 * The `crm_contacts` quota counter for `billing.requireQuota` / `requireAgencyQuota`, shared by every caller: the
 * agency's contact-quota lock, then the capped count. Called only when the plan has a limit, so unlimited plans never
 * serialise their creates.
 */
export const contactQuotaUsed =
  (tx: Tx, agencyId: string) =>
  async (cap: number): Promise<number> => {
    await lockContactQuota(tx, agencyId);
    return countLiveContactsUpTo(tx, agencyId, cap);
  };

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

/** What an absorb did to one contact: its new version and its consents before and after (S16-F5: consent records). */
export interface AbsorbResult {
  id: string;
  version: number;
  wasMarketing: boolean;
  wasProcessing: boolean;
  marketing: boolean;
  processing: boolean;
}

/** The consent records an absorb owes: each consent whose value changed. */
export function absorbConsentChanges(
  results: readonly AbsorbResult[],
): { contactId: string; purpose: 'MARKETING' | 'PROCESSING'; granted: boolean }[] {
  return results.flatMap((r) => [
    ...(r.marketing !== r.wasMarketing
      ? [{ contactId: r.id, purpose: 'MARKETING' as const, granted: r.marketing }]
      : []),
    ...(r.processing !== r.wasProcessing
      ? [{ contactId: r.id, purpose: 'PROCESSING' as const, granted: r.processing }]
      : []),
  ]);
}

/**
 * Applies absorb patches (one statement for any number of contacts); returns the new versions and (S16-F5) each
 * contact's consents before (`o`, the statement's snapshot) and after.
 */
export async function absorb(
  tx: Tx,
  agencyId: string,
  patches: readonly AbsorbPatch[],
  maxTags: number,
): Promise<AbsorbResult[]> {
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
    join ${contacts} o on o.id = p.contact_id and o.agency_id = ${agencyId}
    where c.id = p.contact_id and c.agency_id = ${agencyId} and c.deleted_at is null and o.id = c.id
    returning c.id, c.version, o.consent_marketing as "wasMarketing", o.consent_processing as "wasProcessing",
      c.consent_marketing as marketing, c.consent_processing as processing`);
  return res.rows as unknown as AbsorbResult[];
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
 * own transaction — all of them in one statement (`repointReferences`), whatever their number. Leads (S10-02) are
 * here; **S10-04 (activities) and S10-05 (tasks) add their table here** (`contacts.int.test.ts` fails on a crm table with a
 * `contact_id` column that is missing); modules outside crm (registrations, `property_privates`) react to
 * `crm.contact.merged` instead (events.ts).
 */
export const CONTACT_REFERENCES = [
  { name: 'contact_notes', table: contactNotes, versioned: false },
  // S10-02: a merged contact's leads follow it, with a new version (an open edit form conflicts); their introductions
  // name no contact.
  { name: 'leads', table: leads, versioned: true },
  // S10-04: the duplicate's activities join the survivor's timeline (partitioned: `activities_contact_idx` on each
  // month serves the update).
  { name: 'activities', table: activities, versioned: false },
  // S10-05: the duplicate's tasks (deleted ones too) follow it, with a new version (an open edit form conflicts).
  { name: 'tasks', table: tasks, versioned: true },
  // S10-06: the duplicate's calendar attendances (an event with both contacts reads them as one).
  { name: 'calendar_event_attendees', table: calendarEventAttendees, versioned: false },
  // S10-07: the duplicate's seller prospects (deleted ones too), with a new version (an open edit form conflicts); the
  // listings it sold follow through `crm.contact.merged` (`property_privates` is properties').
  { name: 'seller_prospects', table: sellerProspects, versioned: true },
] as const;

/** Moves every reference of `fromId` to `toId` (one statement); returns the rows moved per table. */
export async function repointReferences(
  tx: Tx,
  agencyId: string,
  fromId: string,
  toId: string,
): Promise<Record<string, number>> {
  const ctes = CONTACT_REFERENCES.map(
    (ref, i) => sql`${sql.raw(`r${i}`)} as (update ${ref.table} set contact_id = ${toId}${
      ref.versioned ? sql`, version = version + 1, updated_at = now()` : sql``
    }
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

/** What an erased contact's free-text titles become (task, prospect, calendar event): a dash, in every language. */
export const ERASED_TITLE = '—';

/**
 * Contact erasure (S11-F12), one statement: the contact (and the closed contacts merged into it earlier) become
 * tombstones — names, primaries, language and tags cleared, consents off (their times kept as the record), never
 * contacted again, closed; their e-mails, phones, facets and notes are deleted. Their leads lose the message, the
 * visitor's details and the replay hashes; their tasks the title (`ERASED_TITLE`) and description; their seller
 * prospects the title, the confidential notes and the seller link. Calendar events they attend get a new version (the
 * ICS feed's fingerprint changes, so no 304 serves the old name); those where no other contact attends also lose the
 * title, description and location. Kept: every id and timestamp (leads, tasks, prospects, attendances and activities
 * still point at the tombstone, so reports and timelines keep their counts). Activity bodies, the inbound website
 * leads and the listings' seller link are cleared after the commit, batched (`activitiesRepo.clearContactBodies`,
 * `crm.eraseContactData`). Returns the rows changed per table.
 */
export async function eraseContact(tx: Tx, agencyId: string, contactId: string): Promise<Record<string, number>> {
  return eraseContacts(tx, agencyId, [contactId]);
}

/**
 * S16-F5: `eraseContact` for any number of contacts in **one statement** (the system paths erase a batch of
 * `SYSTEM_ERASE_BATCH` at once; no per-contact loop). The same tombstones and clears for every contact of `contactIds`
 * and the closed contacts merged into them; a calendar event loses its text when no contact outside the set attends.
 * Returns the rows changed per table, summed over the set.
 */
export async function eraseContacts(
  tx: Tx,
  agencyId: string,
  contactIds: readonly string[],
): Promise<Record<string, number>> {
  if (contactIds.length === 0) return {};
  const ids = sql`${sql.param([...contactIds])}::uuid[]`;
  const res = await tx.execute(sql`
    with c as (
        update ${contacts} set
          first_name = null, last_name = null, primary_email = null, primary_phone = null, language = null,
          tags = '{}'::text[], consent_marketing = false, consent_processing = false, do_not_contact = true,
          idempotency_hash = null,
          deleted_at = coalesce(deleted_at, now()),
          version = case when id = any(${ids}) then version + 1 else version end,
          updated_at = now()
        where agency_id = ${agencyId} and (id = any(${ids}) or merged_into_id = any(${ids}))
        returning id),
      e as (delete from ${contactEmails} where agency_id = ${agencyId} and contact_id in (select id from c) returning 1),
      p as (delete from ${contactPhones} where agency_id = ${agencyId} and contact_id in (select id from c) returning 1),
      f as (delete from ${contactFacets} where agency_id = ${agencyId} and contact_id in (select id from c) returning 1),
      n as (delete from ${contactNotes} where agency_id = ${agencyId} and contact_id in (select id from c) returning 1),
      l as (update ${leads} set message = null, visitor_name = null, visitor_email = null, visitor_phone = null,
            idempotency_hash = null, request_hash = null, version = version + 1, updated_at = now()
          where agency_id = ${agencyId} and contact_id = any(${ids})
          returning 1),
      t as (update ${tasks} set title = ${ERASED_TITLE}, description = null, version = version + 1, updated_at = now()
          where agency_id = ${agencyId} and contact_id = any(${ids}) returning 1),
      s as (update ${sellerProspects} set title = ${ERASED_TITLE}, contact_id = null, confidential_notes = null,
            version = version + 1, updated_at = now()
          where agency_id = ${agencyId} and contact_id = any(${ids}) returning 1),
      ev as (update ${calendarEvents} ce set
            title = case when sole.only then ${ERASED_TITLE} else ce.title end,
            description = case when sole.only then null else ce.description end,
            location = case when sole.only then null else ce.location end,
            version = ce.version + 1, updated_at = now()
          from (select distinct a.event_id, not exists (
                  select 1 from ${calendarEventAttendees} o
                  where o.agency_id = ${agencyId} and o.event_id = a.event_id and o.contact_id is not null
                    and o.contact_id <> all(${ids})) as only
                from ${calendarEventAttendees} a
                where a.agency_id = ${agencyId} and a.contact_id = any(${ids})) sole
          where ce.agency_id = ${agencyId} and ce.id = sole.event_id
          returning 1)
    select (select count(*) from c)::int as contacts, (select count(*) from e)::int as emails,
      (select count(*) from p)::int as phones, (select count(*) from f)::int as facets,
      (select count(*) from n)::int as notes, (select count(*) from l)::int as leads,
      (select count(*) from t)::int as tasks, (select count(*) from s)::int as prospects,
      (select count(*) from ev)::int as events`);
  return res.rows[0] as Record<string, number>;
}

/** S16-F5: the closed contacts merged into any of `contactIds` (one query, `contacts_merged_into_idx`). */
export async function mergedIntoAny(tx: Tx, agencyId: string, contactIds: readonly string[]): Promise<string[]> {
  if (contactIds.length === 0) return [];
  const rows = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.agencyId, agencyId), inArray(contacts.mergedIntoId, [...contactIds])));
  return rows.map((r) => r.id);
}

/** Up to `limit` inbound website leads (`leads.inbound_lead_id`) of the contacts' leads after `afterId`, by id. */
export async function inboundLeadsOf(
  tx: Tx,
  agencyId: string,
  contactIds: readonly string[],
  afterId: string | null,
  limit: number,
): Promise<string[]> {
  if (contactIds.length === 0) return [];
  const rows = await tx
    .select({ id: leads.inboundLeadId })
    .from(leads)
    .where(
      and(
        eq(leads.agencyId, agencyId),
        inArray(leads.contactId, [...contactIds]),
        isNotNull(leads.inboundLeadId),
        afterId ? gt(leads.inboundLeadId, afterId) : undefined,
      ),
    )
    .orderBy(leads.inboundLeadId)
    .limit(limit);
  return rows.map((r) => r.id).filter((id): id is string => id !== null);
}

/** S16-04: whether `contactId` is an open contact of the agency (a data subject export names one). */
export async function openContactExists(tx: Tx, agencyId: string, contactId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.agencyId, agencyId), eq(contacts.id, contactId), isNull(contacts.deletedAt)))
    .limit(1);
  return row !== undefined;
}

/**
 * S16-04, agency erasure: up to `limit` open contacts of the agency (`contacts_agency_created_idx`). Each one erased
 * closes it, so the next call answers the next ones; merged (closed) contacts follow their survivor's erasure.
 */
export async function openContactIds(tx: Tx, agencyId: string, limit: number): Promise<string[]> {
  const rows = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.agencyId, agencyId), isNull(contacts.deletedAt)))
    .orderBy(contacts.createdMs, contacts.id)
    .limit(limit);
  return rows.map((r) => r.id);
}

/** S17-F3: the retention scan's keyset position — the last candidate's `updated_at` (database text, microseconds kept) and id. */
export interface RetentionCursor {
  at: string;
  id: string;
}

/**
 * S16-04, retention: one page of the agency's open contacts untouched since `cutoff`, after `after` — the candidates
 * (`limit` at most, oldest `updated_at` first: S17-F3, `contacts_retention_idx` `(agency_id, updated_at, id)` where
 * `deleted_at is null`, a range scan over exactly the contacts unchanged since the cutoff), and of those the inactive
 * ones: no open lead (`NEW`, `IN_PROGRESS`: a live deal is never erased), none of its leads, tasks or activities changed
 * or logged since, its leads' activities included (`activities_lead_idx`). The caller also keeps sellers of active
 * listings (properties). Each probe is an index lookup per candidate (`leads_contact_idx`, `tasks_contact_all_idx`,
 * `activities_contact_idx` / `activities_lead_idx`). `last` is the page's last candidate (null: no more) — a kept
 * contact is never read twice in a run, so a page costs `limit` probes whatever the agency's size.
 */
export async function inactiveContactsPage(
  tx: Tx,
  agencyId: string,
  cutoff: Date,
  after: RetentionCursor | null,
  limit: number,
): Promise<{ ids: string[]; last: RetentionCursor | null }> {
  const at = cutoff.toISOString();
  const res = await tx.execute(sql`
    with cand as (
      select c.id, c.updated_at from ${contacts} c
       where c.agency_id = ${agencyId} and c.deleted_at is null and c.updated_at < ${at}::timestamptz
         ${after ? sql`and (c.updated_at, c.id) > (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
       order by c.updated_at, c.id
       limit ${limit})
    select c.id, c.updated_at::text as at,
      (not exists (select 1 from ${leads} l
                    where l.agency_id = ${agencyId} and l.contact_id = c.id
                      and (l.updated_at >= ${at}::timestamptz or l.status in ('NEW', 'IN_PROGRESS')))
       and not exists (select 1 from ${tasks} t
                        where t.agency_id = ${agencyId} and t.contact_id = c.id and t.updated_at >= ${at}::timestamptz)
       and not exists (select 1 from ${activities} a
                        where a.agency_id = ${agencyId} and a.contact_id = c.id and a.occurred_at >= ${at}::timestamptz)
       and not exists (select 1 from ${leads} l2 join ${activities} a2
                          on a2.agency_id = l2.agency_id and a2.lead_id = l2.id and a2.occurred_at >= ${at}::timestamptz
                        where l2.agency_id = ${agencyId} and l2.contact_id = c.id)) as inactive
      from cand c
     order by c.updated_at, c.id`);
  const rows = res.rows as { id: string; at: string; inactive: boolean }[];
  const tail = rows.length === limit ? rows[rows.length - 1] : undefined;
  return {
    ids: rows.filter((r) => r.inactive).map((r) => r.id),
    last: tail ? { at: tail.at, id: tail.id } : null,
  };
}

/**
 * S17-F3: the agency text sweep's position — the step (table walk) and the last row's index key in it (database text:
 * timestamps keep their microseconds). Stored in the erasure operation's cursor between calls.
 */
export interface AgencyTextCursor {
  step: number;
  key: string[] | null;
}

interface TextStep {
  /** The table, as drizzle renders it. */
  table: SQL;
  /** The index walked (agency first): its columns after `agency_id` and their types, the last one `id`. */
  keys: readonly (readonly [string, 'uuid' | 'text' | 'timestamptz'])[];
  /** Rows of the walk (the walked index's partial predicate). */
  rows: SQL;
  /**
   * S17-F3 review: the primary key the update matches on (never the walk's mutable keys: a task whose status changes
   * between the read and the update is still cleared), and a bound on the updated side to the page's range (an
   * immutable key: partitions pruned, no scan of the agency's other rows).
   */
  pk: readonly string[];
  bound?: SQL;
  /** The row's text still to clear, and how. */
  pending: SQL;
  set: SQL;
}

/**
 * S16-04 review, agency erasure — the agency's free text outside contact rows, one table walk per step: activity
 * bodies (`activities_agency_idx`), task titles / descriptions (live: `tasks_agency_idx`, deleted:
 * `tasks_agency_deleted_idx`), calendar event titles / descriptions / locations (`calendar_events_agency_idx`), seller
 * prospect titles, addresses and confidential notes (live: `seller_prospects_created_idx`, deleted:
 * `seller_prospects_agency_deleted_idx`), lead messages and visitor details (`leads_agency_created_idx`), then contact
 * notes (deleted). S17-F3: each step walks its index on a keyset from the cursor, `limit` rows a statement, and clears
 * the ones still holding text — a cleared row is never read again, so no statement scans more than `limit` rows.
 */
function agencyTextSteps(): readonly TextStep[] {
  const erased = sql`${ERASED_TITLE}`;
  const stamp = sql.raw('version = version + 1, updated_at = now()');
  return [
    {
      table: sql`${activities}`,
      keys: [
        ['occurred_at', 'timestamptz'],
        ['id', 'uuid'],
      ],
      rows: sql`true`,
      pk: ['id', 'occurred_at'],
      bound: sql`and x.occurred_at >= (select min(p.occurred_at) from p) and x.occurred_at <= (select max(p.occurred_at) from p)`,
      pending: sql`x.body is not null`,
      set: sql`body = null`,
    },
    {
      table: sql`${tasks}`,
      keys: [
        ['status', 'text'],
        ['due_sort_ms', 'timestamptz'],
        ['id', 'uuid'],
      ],
      rows: sql`deleted_at is null`,
      pk: ['id'],
      pending: sql`(x.title <> ${erased} or x.description is not null)`,
      set: sql`title = ${erased}, description = null, ${stamp}`,
    },
    {
      table: sql`${tasks}`,
      keys: [['id', 'uuid']],
      rows: sql`deleted_at is not null`,
      pk: ['id'],
      pending: sql`(x.title <> ${erased} or x.description is not null)`,
      set: sql`title = ${erased}, description = null, ${stamp}`,
    },
    {
      table: sql`${calendarEvents}`,
      keys: [
        ['starts_at', 'timestamptz'],
        ['id', 'uuid'],
      ],
      rows: sql`true`,
      pk: ['id'],
      pending: sql`(x.title <> ${erased} or x.description is not null or x.location is not null)`,
      set: sql`title = ${erased}, description = null, location = null, ${stamp}`,
    },
    {
      table: sql`${sellerProspects}`,
      keys: [
        ['created_ms', 'timestamptz'],
        ['id', 'uuid'],
      ],
      rows: sql`deleted_at is null`,
      pk: ['id'],
      pending: sql`(x.title <> ${erased} or x.address is not null or x.area is not null or x.confidential_notes is not null)`,
      set: sql`title = ${erased}, address = null, area = null, confidential_notes = null, ${stamp}`,
    },
    {
      table: sql`${sellerProspects}`,
      keys: [['id', 'uuid']],
      rows: sql`deleted_at is not null`,
      pk: ['id'],
      pending: sql`(x.title <> ${erased} or x.address is not null or x.area is not null or x.confidential_notes is not null)`,
      set: sql`title = ${erased}, address = null, area = null, confidential_notes = null, ${stamp}`,
    },
    {
      table: sql`${leads}`,
      keys: [
        ['created_ms', 'timestamptz'],
        ['id', 'uuid'],
      ],
      rows: sql`true`,
      pk: ['id'],
      pending: sql`(x.message is not null or x.visitor_name is not null or x.visitor_email is not null or x.visitor_phone is not null)`,
      set: sql`message = null, visitor_name = null, visitor_email = null, visitor_phone = null,
        idempotency_hash = null, request_hash = null, ${stamp}`,
    },
  ];
}

/** Steps of the agency text sweep: the table walks, then the contact notes. */
export const AGENCY_TEXT_STEPS = agencyTextSteps().length + 1;

/**
 * One statement of the agency text sweep (see `agencyTextSteps`): `limit` rows of the cursor's step read on its index
 * keyset, those still holding text cleared. Answers the rows changed and the next cursor (null: every step done).
 */
export async function clearAgencyText(
  tx: Tx,
  agencyId: string,
  cursor: AgencyTextCursor,
  limit: number,
): Promise<{ rows: number; next: AgencyTextCursor | null }> {
  const steps = agencyTextSteps();
  const nextStep = (step: number): AgencyTextCursor | null =>
    step + 1 < AGENCY_TEXT_STEPS ? { step: step + 1, key: null } : null;
  const s = steps[cursor.step];
  if (!s) {
    // the last step: the agency's contact notes, deleted (`contact_notes_contact_created_raw_idx`, agency first)
    const res = await tx.execute(sql`
      with n as (delete from ${contactNotes} where agency_id = ${agencyId} and id in (
          select id from ${contactNotes} where agency_id = ${agencyId}
           order by contact_id, created_at, id limit ${limit})
        returning 1)
      select count(*)::int as rows from n`);
    const rows = (res.rows[0] as { rows: number }).rows;
    return { rows, next: rows < limit ? nextStep(cursor.step) : cursor };
  }
  // column names and casts are constants of `agencyTextSteps`; only the cursor's values are parameters
  const names = s.keys.map(([k]) => k);
  const cols = sql.raw(names.join(', '));
  const keyText = sql.raw(`array[${names.map((k) => `p.${k}::text`).join(', ')}]`);
  const lastOrder = sql.raw(names.map((k) => `p.${k} desc`).join(', '));
  const key = cursor.key;
  const after =
    key && key.length === s.keys.length
      ? sql`and (${cols}) > (${sql.join(
          s.keys.map(([, type], i) => sql`${key[i] ?? null}::${sql.raw(type)}`),
          sql`, `,
        )})`
      : sql``;
  const match = sql.raw(s.pk.map((k) => `x.${k} = p.${k}`).join(' and '));
  const res = await tx.execute(sql`
    with p as (
        select ${cols} from ${s.table}
         where agency_id = ${agencyId} and ${s.rows} ${after}
         order by ${cols} limit ${limit}),
      u as (update ${s.table} x set ${s.set}
        from p where x.agency_id = ${agencyId} and ${match} ${s.bound ?? sql``} and ${s.pending}
        returning 1)
    select (select count(*) from u)::int as rows, (select count(*) from p)::int as walked,
      (select ${keyText} from p order by ${lastOrder} limit 1) as key`);
  const row = res.rows[0] as { rows: number; walked: number; key: string[] | null };
  return {
    rows: row.rows,
    next: row.walked < limit || !row.key ? nextStep(cursor.step) : { step: cursor.step, key: row.key },
  };
}

/** S16-04: the ids of the contacts' leads and tasks (an erasure redacts their notifications). Bounded per person. */
export async function noticeTargetsOf(
  tx: Tx,
  agencyId: string,
  contactIds: readonly string[],
): Promise<{ leadIds: string[]; taskIds: string[] }> {
  if (contactIds.length === 0) return { leadIds: [], taskIds: [] };
  const l = await tx
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.agencyId, agencyId), inArray(leads.contactId, [...contactIds])));
  const t = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.agencyId, agencyId), inArray(tasks.contactId, [...contactIds])));
  return { leadIds: l.map((r) => r.id), taskIds: t.map((r) => r.id) };
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

/** A contact's notes, newest first (raw keyset on `contact_notes_contact_created_raw_idx`). */
export async function listNotes(
  tx: Tx,
  agencyId: string,
  contactId: string,
  page: { limit: number; cursor?: KeysetCursor },
): Promise<(NoteRow & { atUs: string })[]> {
  return tx
    .select({ ...noteColumns, atUs: keysetStamp(contactNotes.createdAt) })
    .from(contactNotes)
    .where(
      and(
        eq(contactNotes.agencyId, agencyId),
        eq(contactNotes.contactId, contactId),
        keysetAfterRaw(contactNotes.createdAt, contactNotes.id, page.cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrderRaw(contactNotes.createdAt, contactNotes.id, 'desc'))
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
): Promise<(ImportRow & { atUs: string })[]> {
  return tx
    .select({ ...importColumns, atUs: keysetStamp(contactImports.createdAt) })
    .from(contactImports)
    .where(
      and(
        eq(contactImports.agencyId, agencyId),
        keysetAfterRaw(contactImports.createdAt, contactImports.id, page.cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrderRaw(contactImports.createdAt, contactImports.id, 'desc'))
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
  agencyIds?: readonly string[],
): Promise<{ id: string; agencyId: string; status: string }[]> {
  const scope = agencyIds
    ? sql`and agency_id in (${sql.join(
        agencyIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql``;
  const latest = uploadedBefore > finishedBefore ? uploadedBefore : finishedBefore;
  const res = await tx.execute(sql`
    select id, agency_id as "agencyId", status from ${contactImports}
    where file_deleted_at is null and created_at < ${latest.toISOString()}::timestamptz ${scope}
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
