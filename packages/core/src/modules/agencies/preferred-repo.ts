import type { Tx } from '@inmolink/db';
import { agencies, agencyDirectory, preferredAgencies, preferredAgencyNotes } from '@inmolink/db/schema/agencies';
import { and, asc, count, eq, ilike, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfter, keysetOrder } from '../../pagination';

/**
 * Preferred agencies and the agency directory (S1-07, PATTERNS §5). Runs as `app_user` under
 * `withTenant`: `preferred_agencies` / `preferred_agency_notes` rows of the caller's agency, and the
 * directory rows RLS lets a verified agency read (listed ones, plus its own). Guard triggers (0022)
 * repeat the service rules for direct writes.
 */

export interface PreferredRow {
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
        keysetAfter(preferredAgencies.createdAt, preferredAgencies.preferredAgencyId, cursor, 'asc'),
      ),
    )
    .orderBy(...keysetOrder(preferredAgencies.createdAt, preferredAgencies.preferredAgencyId, 'asc'))
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
  /** Agencies that list the caller as preferred (theirs to show it PREFERRED listings), at most `cap`. */
  preferring: string[];
  /** The caller's own preferred list (≤ `MAX_PREFERRED_AGENCIES`). */
  preferred: string[];
}

export async function networkStanding(tx: Tx, agencyId: string, cap: number): Promise<NetworkStandingRow | null> {
  const [row] = await tx
    .select({
      createdAt: agencies.createdAt,
      giveToGetExempt: agencies.giveToGetExempt,
      // The listing policy's own helper (S1-07): exactly the owners whose PREFERRED listings RLS shows the caller.
      preferring: sql<string[]>`array(select a::text from public.app_preferring_agencies() a limit ${cap})`,
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
