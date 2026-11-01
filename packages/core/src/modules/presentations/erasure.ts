import { withSystem } from '@inmolink/db';
import { selectionInteractions, selectionItems, selections } from '@inmolink/db/schema/presentations';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

/**
 * Erasure, the selections side (S16-04 review). A selection made for a client carries the agent's title and message to
 * them ("Villas for Sofia"), per-listing notes, and the client's enquiry messages:
 *
 * - `eraseContactSelections` (contact erasure, `presentations.eraseContactSelections` on `crm.contact.erased`): the
 *   selections of the erased contacts are revoked (the link stops working), their title becomes `—`, their message and
 *   item notes go, and their interactions (views, likes, enquiry messages) are deleted.
 * - `eraseAgencySelections` (agency erasure): the same for every selection of the agency, a batch at a time.
 *
 * Kept: ids, the items' listings, times. Worker-only (`withSystem`, the agency an explicit predicate). Idempotent.
 */

const ERASED_TITLE = '—';
/** Selections per statement (agency erasure). */
const BATCH = 500;

async function eraseSelections(tx: Parameters<Parameters<typeof withSystem>[1]>[0], agencyId: string, ids: string[]) {
  if (ids.length === 0) return 0;
  await tx
    .delete(selectionInteractions)
    .where(and(eq(selectionInteractions.agencyId, agencyId), inArray(selectionInteractions.selectionId, ids)));
  await tx
    .update(selectionItems)
    .set({ note: null, titleOverride: null })
    .where(and(eq(selectionItems.agencyId, agencyId), inArray(selectionItems.selectionId, ids)));
  const rows = await tx
    .update(selections)
    .set({
      title: ERASED_TITLE,
      message: null,
      revokedAt: sql`coalesce(${selections.revokedAt}, now())`,
      version: sql`${selections.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(selections.agencyId, agencyId), inArray(selections.id, ids)))
    .returning({ id: selections.id });
  return rows.length;
}

export async function eraseContactSelections(p: {
  agencyId: string;
  contactIds: readonly string[];
}): Promise<{ selections: number }> {
  if (p.contactIds.length === 0) return { selections: 0 };
  const n = await withSystem('presentations.eraseContactSelections', async (tx) => {
    const ids = (
      await tx
        .select({ id: selections.id })
        .from(selections)
        .where(
          and(
            eq(selections.agencyId, p.agencyId),
            inArray(selections.contactId, [...p.contactIds]),
            or(sql`${selections.title} <> ${ERASED_TITLE}`, isNull(selections.revokedAt)),
          ),
        )
    ).map((r) => r.id);
    return eraseSelections(tx, p.agencyId, ids);
  });
  return { selections: n };
}

/** One batch of the agency's not yet erased selections; `more`: call again. */
export async function eraseAgencySelections(p: { agencyId: string }): Promise<{ selections: number; more: boolean }> {
  return withSystem('presentations.eraseAgencySelections', async (tx) => {
    const ids = (
      await tx
        .select({ id: selections.id })
        .from(selections)
        .where(
          and(
            eq(selections.agencyId, p.agencyId),
            or(
              sql`${selections.title} <> ${ERASED_TITLE}`,
              isNull(selections.revokedAt),
              sql`${selections.message} is not null`,
            ),
          ),
        )
        .limit(BATCH)
    ).map((r) => r.id);
    const n = await eraseSelections(tx, p.agencyId, ids);
    return { selections: n, more: ids.length === BATCH };
  });
}
