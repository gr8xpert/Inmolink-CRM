import { cacheConnection } from '@inmolink/platform/cache';
import { CDN_PURGE_MAX_TAGS } from '@inmolink/platform/cdn';

/**
 * Pending edge purges per agency (S7-06 review): tags wait in a sorted set on redis-cache (score = when the change
 * committed; a tag added again keeps its latest time), so bursts coalesce into one purge request of up to 100 tags per
 * agency run, and the agency's purge job is throttled (`EDGE_PURGE_THROTTLE_MS`): one tenant gets at most one purge
 * request per throttle window and cannot spend the account's purge budget alone.
 */
const pendingKey = (agencyId: string) => `inl:edge-purge:{${agencyId}}`;

/** One purge run per agency per window at most: ≤ 12 requests (1,200 tags) a minute per tenant. */
export const EDGE_PURGE_THROTTLE_MS = 5_000;
/** Pending tags expire if no job ever drains them (no purger configured): far beyond any cached lifetime. */
const PENDING_TTL_SECONDS = 86_400;
/** Pops per run while skipping expired tags (bounds a run's Redis work). */
const MAX_POPS = 20;

export interface PendingTag {
  tag: string;
  /** When the change committed (epoch ms). */
  at: number;
}

/** Adds tags to the agency's pending set. */
export async function addPendingPurges(agencyId: string, tags: readonly PendingTag[]): Promise<void> {
  if (tags.length === 0) return;
  const key = pendingKey(agencyId);
  const args = tags.flatMap((t) => [t.at, t.tag] as const);
  // GT: an existing tag only moves to a later time; new tags are added.
  await cacheConnection()
    .multi()
    .zadd(key, 'GT', ...args)
    .expire(key, PENDING_TTL_SECONDS)
    .exec();
}

/** Site and key tags end access (suspension, revocation): never dropped for their age. */
const ageless = (tag: string) => tag.startsWith('s') || tag.startsWith('k');

/**
 * Takes up to `CDN_PURGE_MAX_TAGS` tags, oldest first; listing and development tags older than `cutoff` are dropped
 * (their cached answers have expired). `more`: tags are left.
 */
export async function takePendingPurges(
  agencyId: string,
  cutoff: number,
): Promise<{ tags: PendingTag[]; dropped: number; more: boolean }> {
  const redis = cacheConnection();
  const key = pendingKey(agencyId);
  const tags: PendingTag[] = [];
  let dropped = 0;
  for (let i = 0; i < MAX_POPS && tags.length < CDN_PURGE_MAX_TAGS; i++) {
    const popped = await redis.zpopmin(key, CDN_PURGE_MAX_TAGS - tags.length);
    if (popped.length === 0) break;
    for (let j = 0; j < popped.length; j += 2) {
      const tag = popped[j] as string;
      const at = Number(popped[j + 1]);
      if (!ageless(tag) && at < cutoff) dropped++;
      else tags.push({ tag, at });
    }
  }
  return { tags, dropped, more: (await redis.zcard(key)) > 0 };
}

/** Puts tags back after a failed purge (the retry takes them again). */
export async function returnPendingPurges(agencyId: string, tags: readonly PendingTag[]): Promise<void> {
  await addPendingPurges(agencyId, tags);
}

/** Drops the agency's pending tags (no edge cache to purge). */
export async function clearPendingPurges(agencyId: string): Promise<void> {
  await cacheConnection().del(pendingKey(agencyId));
}
