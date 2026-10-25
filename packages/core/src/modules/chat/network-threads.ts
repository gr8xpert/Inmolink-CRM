import { withSystem } from '@inmolink/db';
import * as repo from './repo';

/** Reply threads of one post closed per statement (the poster's copies, and the repliers' copies of those threads). */
export const NETWORK_CLOSE_BATCH = 500;

/**
 * S12-F12, `network.closePostThreads` (one per `network.post.closed`): every reply thread of a closed network post
 * becomes read-only, both copies — the poster's and each replying agency's — like `closeViewingThread`. A closed post
 * is never reopened (`network_posts_guard`); the network module re-reads it and passes its agency (the poster's). Batches of `NETWORK_CLOSE_BATCH` threads, one transaction each; idempotent (closed copies are skipped).
 */
export async function closeNetworkThreads(p: { agencyId: string; postId: string }): Promise<{ closed: number }> {
  let closed = 0;
  for (;;) {
    const r = await withSystem(`chat.closeNetworkThreads: ${p.postId}`, (tx) =>
      repo.closeNetworkThreads(tx, p.agencyId, p.postId, NETWORK_CLOSE_BATCH),
    );
    closed += r.copies;
    if (r.threads < NETWORK_CLOSE_BATCH) return { closed };
  }
}
