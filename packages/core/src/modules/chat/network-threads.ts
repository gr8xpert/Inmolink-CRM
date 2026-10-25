import type { Tx } from '@inmolink/db';
import * as repo from './repo';

/** Reply threads of one post closed per statement (the poster's copies, and the repliers' copies of those threads). */
export const NETWORK_CLOSE_BATCH = 500;

/**
 * Worker form (S12-F12; PATTERNS §12): up to `NETWORK_CLOSE_BATCH` open reply threads of a network post become
 * read-only, both copies — the poster's and each replying agency's — like `closeViewingThread`. It trusts its
 * arguments: the caller (`network.closePostThreads`) runs it in the `withSystem` transaction in which it re-read the
 * post as CLOSED and of `posterAgencyId`. Never call it from a request path. Idempotent (closed copies are skipped).
 */
export async function closeNetworkThreadsForWorker(
  tx: Tx,
  posterAgencyId: string,
  postId: string,
): Promise<{ threads: number; copies: number }> {
  return repo.closeNetworkThreads(tx, posterAgencyId, postId, NETWORK_CLOSE_BATCH);
}
