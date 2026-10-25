import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import * as repo from './repo';

/**
 * S13-F9: social post retention — PUBLISHED and FAILED posts are kept this many months after their last change, then
 * deleted `PRUNE_BATCH` per statement by `social.pruneFinishedPosts` (drafts, scheduled and cancelled posts stay: the
 * agency removes those). The post at Meta is untouched.
 */
export const POST_RETENTION = { MONTHS: 12, PRUNE_BATCH: 5_000 } as const;

/** The daily prune (all agencies, `withSystem`): finished posts older than `POST_RETENTION.MONTHS`, batch by batch. */
export async function pruneFinishedPosts(
  nowMs: number = clock.nowMs(),
  signal?: AbortSignal,
): Promise<{ deleted: number }> {
  const before = new Date(nowMs);
  before.setUTCMonth(before.getUTCMonth() - POST_RETENTION.MONTHS);
  let deleted = 0;
  for (;;) {
    const n = await withSystem('social.pruneFinishedPosts', (tx) =>
      repo.pruneFinishedPosts(tx, before, POST_RETENTION.PRUNE_BATCH),
    );
    deleted += n;
    if (n < POST_RETENTION.PRUNE_BATCH || signal?.aborted) break;
  }
  return { deleted };
}
