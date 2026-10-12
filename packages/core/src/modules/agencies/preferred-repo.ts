import type { Tx } from '@inmolink/db';
import { agencyDirectory, preferredAgencies, preferredAgencyNotes } from '@inmolink/db/schema/agencies';
import { and, asc, count, eq, gt, ilike, isNotNull, ne, or, sql } from 'drizzle-orm';
import type { KeysetCursor } from '../../pagination';

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
        cursor
          ? or(
              gt(preferredAgencies.createdAt, cursor.at),
              and(eq(preferredAgencies.createdAt, cursor.at), gt(preferredAgencies.preferredAgencyId, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(asc(preferredAgencies.createdAt), asc(preferredAgencies.preferredAgencyId))
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
