import type { Tx } from '@inmolink/db';
import * as repo from './repo';

/**
 * R2-02c, for the match engine's learned boost (worker-only, `app_system`; ids, a flag and a time only):
 *
 * - `selectionContactOf`: who a selection is for (null: no such selection);
 * - `contactLikeState`: the client's latest like or unlike of a listing across all the contact's selections, and
 *   when (null: neither) — the current state, so likes and unlikes delivered out of order, or on two selections,
 *   still end in the client's last word.
 */
export function selectionContactOf(
  tx: Tx,
  selectionId: string,
): Promise<{ agencyId: string; contactId: string | null } | null> {
  return repo.selectionContact(tx, selectionId);
}

export function contactLikeState(
  tx: Tx,
  p: { agencyId: string; contactId: string; targetId: string },
): Promise<{ liked: boolean; at: Date } | null> {
  return repo.latestLikeOfContact(tx, p);
}
