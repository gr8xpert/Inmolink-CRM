import type { Tx } from '@inmolink/db';
import {
  agencies,
  agencyDirectory,
  agencyProfiles,
  agencySettings,
  preferredAgencies,
  preferredAgencyNotes,
} from '@inmolink/db/schema/agencies';
import { and, asc, count, eq, ilike, inArray, isNotNull, ne, type SQL, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfterRaw, keysetOrderRaw, keysetStamp } from '../../pagination';

/**
 * Preferred agencies and the agency directory (S1-07, PATTERNS §5). Runs as `app_user` under
 * `withTenant`: `preferred_agencies` / `preferred_agency_notes` rows of the caller's agency, and the
 * directory rows RLS lets a verified agency read (listed ones, plus its own). Guard triggers (0022)
 * repeat the service rules for direct writes.
 */

export interface PreferredRow {
  /** `keysetStamp` of the sort time: the exact cursor of the list. */
  atUs: string;
  preferredAgencyId: string;
  createdAt: Date;
  nameWhenAdded: string | null;
  note: string | null;
  noteUpdatedAt: Date | null;
  /** Null when the partner is not in the directory the caller can see (not verified now). */
  directoryName: string | null;
  directoryKind: 'AGENCY' | 'DEVELOPER' | 'PARTNER' | null;
}

const preferredColumns = {
  atUs: keysetStamp(preferredAgencies.createdAt),
  preferredAgencyId: preferredAgencies.preferredAgencyId,
  createdAt: preferredAgencies.createdAt,
  nameWhenAdded: preferredAgencyNotes.nameWhenAdded,
  note: preferredAgencyNotes.note,
  noteUpdatedAt: preferredAgencyNotes.updatedAt,
  directoryName: agencyDirectory.name,
  directoryKind: agencyDirectory.kind,
};

function preferredQuery(tx: Tx) {
  return tx
    .select(preferredColumns)
    .from(preferredAgencies)
    .leftJoin(
      preferredAgencyNotes,
      and(
        eq(preferredAgencyNotes.agencyId, preferredAgencies.agencyId),
        eq(preferredAgencyNotes.preferredAgencyId, preferredAgencies.preferredAgencyId),
      ),
    )
    .leftJoin(
      agencyDirectory,
      and(eq(agencyDirectory.agencyId, preferredAgencies.preferredAgencyId), eq(agencyDirectory.listed, true)),
    );
}

/** The agency's list, oldest first (keyset on `(created_at, preferred_agency_id)`, `preferred_agencies_list_idx`). */
export async function listPreferred(
  tx: Tx,
  agencyId: string,
  page: { limit: number; cursor?: KeysetCursor },
): Promise<PreferredRow[]> {
  const { cursor } = page;
  return preferredQuery(tx)
    .where(
      and(
        eq(preferredAgencies.agencyId, agencyId),
        keysetAfterRaw(preferredAgencies.createdAt, preferredAgencies.preferredAgencyId, cursor, 'asc'),
      ),
    )
    .orderBy(...keysetOrderRaw(preferredAgencies.createdAt, preferredAgencies.preferredAgencyId, 'asc'))
    .limit(page.limit + 1);
}

export async function getPreferred(tx: Tx, agencyId: string, preferredAgencyId: string): Promise<PreferredRow | null> {
  const [row] = await preferredQuery(tx).where(
    and(eq(preferredAgencies.agencyId, agencyId), eq(preferredAgencies.preferredAgencyId, preferredAgencyId)),
  );
  return row ?? null;
}

export async function countPreferred(tx: Tx, agencyId: string): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(preferredAgencies).where(eq(preferredAgencies.agencyId, agencyId));
  return row?.n ?? 0;
}

/** A listed (VERIFIED) agency of the directory, as a verified caller sees it. */
export async function getListedAgency(tx: Tx, agencyId: string) {
  const [row] = await tx
    .select({ name: agencyDirectory.name, kind: agencyDirectory.kind })
    .from(agencyDirectory)
    .where(and(eq(agencyDirectory.agencyId, agencyId), eq(agencyDirectory.listed, true)));
  return row ?? null;
}

/** Inserts the relationship; null when it already exists (primary key). */
export async function insertPreferred(
  tx: Tx,
  agencyId: string,
  preferredAgencyId: string,
): Promise<{ createdAt: Date } | null> {
  const [row] = await tx
    .insert(preferredAgencies)
    .values({ agencyId, preferredAgencyId })
    .onConflictDoNothing()
    .returning({ createdAt: preferredAgencies.createdAt });
  return row ?? null;
}

export async function insertNote(
  tx: Tx,
  row: {
    agencyId: string;
    preferredAgencyId: string;
    nameWhenAdded: string;
    note: string | null;
    createdBy: string;
    now: Date;
  },
): Promise<void> {
  await tx.insert(preferredAgencyNotes).values({
    agencyId: row.agencyId,
    preferredAgencyId: row.preferredAgencyId,
    nameWhenAdded: row.nameWhenAdded,
    note: row.note,
    createdBy: row.createdBy,
    updatedAt: row.now,
  });
}

/** Replaces the note; false when the agency is not on the list. */
export async function updateNote(
  tx: Tx,
  agencyId: string,
  preferredAgencyId: string,
  note: string | null,
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(preferredAgencyNotes)
    .set({ note, updatedAt: now })
    .where(
      and(eq(preferredAgencyNotes.agencyId, agencyId), eq(preferredAgencyNotes.preferredAgencyId, preferredAgencyId)),
    )
    .returning({ agencyId: preferredAgencyNotes.agencyId });
  return rows.length > 0;
}

/** Removes the relationship (its note cascades); false when it was not on the list. */
export async function deletePreferred(tx: Tx, agencyId: string, preferredAgencyId: string): Promise<boolean> {
  const rows = await tx
    .delete(preferredAgencies)
    .where(and(eq(preferredAgencies.agencyId, agencyId), eq(preferredAgencies.preferredAgencyId, preferredAgencyId)))
    .returning({ agencyId: preferredAgencies.agencyId });
  return rows.length > 0;
}

/** `%`, `_` and `\` match themselves in the search text. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Listed agencies whose name contains `q`, by name, except the caller. A scan of the narrow directory
 * (≤ 5,000 rows, PLAN §1; see the schema note) plus one primary-key probe per row returned.
 */
export async function searchDirectory(tx: Tx, selfId: string, q: string, limit: number) {
  return tx
    .select({
      agencyId: agencyDirectory.agencyId,
      name: agencyDirectory.name,
      kind: agencyDirectory.kind,
      preferred: isNotNull(preferredAgencies.preferredAgencyId).mapWith(Boolean),
    })
    .from(agencyDirectory)
    .leftJoin(
      preferredAgencies,
      and(eq(preferredAgencies.agencyId, selfId), eq(preferredAgencies.preferredAgencyId, agencyDirectory.agencyId)),
    )
    .where(
      and(
        eq(agencyDirectory.listed, true),
        ne(agencyDirectory.agencyId, selfId),
        ilike(agencyDirectory.name, `%${likeEscape(q)}%`),
      ),
    )
    .orderBy(sql`lower(${agencyDirectory.name})`, asc(agencyDirectory.agencyId))
    .limit(limit);
}

/** The caller's agency as network search sees it (S5-05): one query. */
export interface NetworkStandingRow {
  createdAt: Date;
  giveToGetExempt: boolean;
  /** The caller's own preferred list (≤ `MAX_PREFERRED_AGENCIES`). */
  preferred: string[];
}

export async function networkStanding(tx: Tx, agencyId: string): Promise<NetworkStandingRow | null> {
  const [row] = await tx
    .select({
      createdAt: agencies.createdAt,
      giveToGetExempt: agencies.giveToGetExempt,
      preferred: sql<string[]>`array(select p.preferred_agency_id::text from public.preferred_agencies p
        where p.agency_id = ${agencyId})`,
    })
    .from(agencies)
    .where(eq(agencies.id, agencyId));
  return row ?? null;
}

/** Directory names of these agencies (listed ones, as RLS shows them to a verified agency): one primary-key probe each. */
export async function directoryNames(tx: Tx, ids: readonly string[]): Promise<{ id: string; name: string }[]> {
  if (ids.length === 0) return [];
  return tx
    .select({ id: agencyDirectory.agencyId, name: agencyDirectory.name })
    .from(agencyDirectory)
    .where(inArray(agencyDirectory.agencyId, [...ids]));
}

/** S11-05: the directory names of those of these agencies that are listed (VERIFIED) now. */
export async function listedDirectoryNames(tx: Tx, ids: readonly string[]): Promise<{ id: string; name: string }[]> {
  if (ids.length === 0) return [];
  return tx
    .select({ id: agencyDirectory.agencyId, name: agencyDirectory.name })
    .from(agencyDirectory)
    .where(and(inArray(agencyDirectory.agencyId, [...ids]), eq(agencyDirectory.listed, true)));
}

export interface PublicAgencyRow {
  agencyId: string;
  name: string;
  contactEmail: string | null;
  contactPhone: string | null;
  websiteUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
}

/**
 * Listed agencies' public presentation (S7-02): directory name + published profile, one statement by primary key.
 * Runs as `app_public` too (`agency_directory` / `agency_profiles` public predicates: listed agencies only).
 */
export async function publicAgencies(tx: Tx, ids: readonly string[]): Promise<PublicAgencyRow[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({
      agencyId: agencyDirectory.agencyId,
      name: agencyDirectory.name,
      contactEmail: agencyProfiles.contactEmail,
      contactPhone: agencyProfiles.contactPhone,
      websiteUrl: agencyProfiles.websiteUrl,
      primaryColor: agencyProfiles.primaryColor,
      accentColor: agencyProfiles.accentColor,
    })
    .from(agencyDirectory)
    .leftJoin(agencyProfiles, eq(agencyProfiles.agencyId, agencyDirectory.agencyId))
    .where(and(inArray(agencyDirectory.agencyId, [...ids]), eq(agencyDirectory.listed, true)));
  return rows.map((r) => ({
    agencyId: r.agencyId,
    name: r.name,
    contactEmail: r.contactEmail ?? null,
    contactPhone: r.contactPhone ?? null,
    websiteUrl: r.websiteUrl ?? null,
    primaryColor: r.primaryColor ?? null,
    accentColor: r.accentColor ?? null,
  }));
}

/**
 * Owners' identity for the white-label sanitizer (S7-02): directory name and published contacts of any agency,
 * listed or not (`agency_directory` / `agency_profiles` public predicates are `true`). One statement.
 */
export async function ownerIdentityRows(
  tx: Tx,
  ids: readonly string[],
): Promise<
  { agencyId: string; name: string | null; email: string | null; phone: string | null; website: string | null }[]
> {
  if (ids.length === 0) return [];
  const rows = await tx.execute(sql`
    select t.id as "agencyId", d.name, p.contact_email as email, p.contact_phone as phone, p.website_url as website
      from unnest(${sql`array[${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}]::uuid[]`}) as t(id)
      left join ${agencyDirectory} d on d.agency_id = t.id
      left join ${agencyProfiles} p on p.agency_id = t.id`);
  return rows.rows as {
    agencyId: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    website: string | null;
  }[];
}

/** `ownerIdentityRows` as a scalar subquery (S7-03): a JSON array, selected by the website API with other reads. */
export function ownerIdentityRowsJson(ids: readonly string[]): SQL {
  if (ids.length === 0) return sql`'[]'::json`;
  return sql`(select coalesce(json_agg(json_build_object('agencyId', t.id, 'name', d.name, 'email', p.contact_email,
      'phone', p.contact_phone, 'website', p.website_url)), '[]'::json)
    from unnest(array[${sql.join(
      [...new Set(ids)].map((id) => sql`${id}`),
      sql`, `,
    )}]::uuid[]) as t(id)
    left join ${agencyDirectory} d on d.agency_id = t.id
    left join ${agencyProfiles} p on p.agency_id = t.id)`;
}

/** One agency's identity as the search index removes it from its documents' text (S7-F5). */
export interface IndexIdentityRow {
  agencyId: string;
  name: string | null;
  directoryName: string | null;
  taxId: string | null;
  addressLine: string | null;
  senderName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
}

/**
 * Agencies' identities for the search index (S7-F5): legal name, directory name, tax id, office address, white-label
 * e-mail sender name and published contacts — of any agency, verified or not. One statement; worker-only (raw `tx`
 * under `withSystem`: `agencies` and `agency_settings` are not public).
 */
export async function indexIdentityRows(tx: Tx, ids: readonly string[]): Promise<IndexIdentityRow[]> {
  if (ids.length === 0) return [];
  const rows = await tx.execute(sql`
    select t.id as "agencyId", a.name, d.name as "directoryName", a.tax_id as "taxId",
           a.address_line as "addressLine", s.white_label_email_sender_name as "senderName",
           p.contact_email as email, p.contact_phone as phone, p.website_url as website
      from unnest(${sql`array[${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}]::uuid[]`}) as t(id)
      left join ${agencies} a on a.agency_id = t.id
      left join ${agencyDirectory} d on d.agency_id = t.id
      left join ${agencySettings} s on s.agency_id = t.id
      left join ${agencyProfiles} p on p.agency_id = t.id`);
  return rows.rows as unknown as IndexIdentityRow[];
}
