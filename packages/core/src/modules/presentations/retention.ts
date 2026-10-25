import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import * as repo from './repo';

/**
 * S13-F9: selection interaction retention — what clients did on a selection's page is kept this many months after the
 * selection ended (revoked or expired); then `presentations.pruneInteractions` deletes it, `PRUNE_BATCH` rows per
 * statement, walking the ended selections `SELECTION_PAGE` at a time. The selection and its items stay (the agency's
 * dashboard list); a live selection keeps its whole history.
 */
export const INTERACTION_RETENTION = { MONTHS: 12, PRUNE_BATCH: 5_000, SELECTION_PAGE: 500 } as const;

/**
 * The daily prune (all agencies, `withSystem`): interactions of selections ended before the retention. Idempotent.
 * `sizes` overrides the batch and page sizes (tests).
 */
export async function pruneSelectionInteractions(
  nowMs: number = clock.nowMs(),
  signal?: AbortSignal,
  sizes: { PRUNE_BATCH: number; SELECTION_PAGE: number } = INTERACTION_RETENTION,
): Promise<{ selections: number; deleted: number }> {
  const before = new Date(nowMs);
  before.setUTCMonth(before.getUTCMonth() - INTERACTION_RETENTION.MONTHS);
  let after: repo.EndedSelection | null = null;
  let selections = 0;
  let deleted = 0;
  for (;;) {
    const page: repo.EndedSelection[] = await withSystem('presentations.pruneInteractions', (tx) =>
      repo.endedSelectionsPage(tx, before, after, sizes.SELECTION_PAGE),
    );
    selections += page.length;
    const ids = page.map((s) => s.id);
    for (;;) {
      const n = await withSystem('presentations.pruneInteractions', (tx) =>
        repo.pruneInteractionsOf(tx, ids, sizes.PRUNE_BATCH),
      );
      deleted += n;
      if (n < sizes.PRUNE_BATCH || signal?.aborted) break;
    }
    after = page.at(-1) ?? null;
    if (page.length < sizes.SELECTION_PAGE || signal?.aborted) break;
  }
  return { selections, deleted };
}
