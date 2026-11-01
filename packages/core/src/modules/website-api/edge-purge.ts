import { cacheConnection } from '@inmolink/platform/cache';
import { CDN_PURGE_MAX_TAGS } from '@inmolink/platform/cdn';

/**
 * Pending edge purges per agency (S7-06 review): tags wait in a sorted set on redis-cache (score = when the change
 * committed; a tag added again keeps its latest time), so bursts coalesce into one purge request of up to 100 tags per
 * agency run, and the agency's purge job is throttled (`EDGE_PURGE_THROTTLE_MS`): one tenant gets at most one purge
 * request per throttle window and cannot spend the account's purge budget alone.
 */
const pendingKey = (agencyId: string) => `inl:edge-purge:{${agencyId}}`;
/**
 * S15-F11 review: the agency's bulk purges (every portal page of an agency whose standing or contacts changed) wait in
 * their own set, taken only once the targeted set is empty — a backlog never delays a withdrawal's purge.
 */
const bulkKey = (agencyId: string) => `inl:edge-purge-bulk:{${agencyId}}`;
/** S15-F11: when an agency's portal pages last changed (epoch ms; `markPortalAgencyChange`). */
const agencyChangeKey = (agencyId: string) => `inl:edge-purge-agency-change:{${agencyId}}`;

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
  /** S15-F11 review: from the bulk set (an agency's whole portal stock), taken after the targeted ones. */
  bulk?: boolean;
}

/** Adds tags to the agency's pending set (`bulk`: its bulk set, drained after the targeted one). */
export async function addPendingPurges(
  agencyId: string,
  tags: readonly PendingTag[],
  options: { bulk?: boolean } = {},
): Promise<void> {
  if (tags.length === 0) return;
  const key = options.bulk ? bulkKey(agencyId) : pendingKey(agencyId);
  const args = tags.flatMap((t) => [t.at, t.tag] as const);
  // GT: an existing tag only moves to a later time; new tags are added.
  await cacheConnection()
    .multi()
    .zadd(key, 'GT', ...args)
    .expire(key, PENDING_TTL_SECONDS)
    .exec();
}

/**
 * Site and key tags end access (suspension, revocation), feed tags too (a rotated token, S7-07; and a feed is cached
 * longer than the horizon): never dropped for their age.
 */
const ageless = (tag: string) =>
  tag.startsWith('s') || tag.startsWith('k') || tag.startsWith('f') || tag.startsWith('p');

/**
 * Takes up to `CDN_PURGE_MAX_TAGS` tags, oldest first — the targeted set first, then the bulk set (S15-F11 review);
 * listing and development tags older than `cutoff` are dropped (their cached answers have expired), portal page tags
 * (`c`) older than `portalCutoff` (an edge copy lives `PORTAL_EDGE_TTL_MS`). `more`: tags are left.
 */
export async function takePendingPurges(
  agencyId: string,
  cutoff: number,
  portalCutoff: number = cutoff,
): Promise<{ tags: PendingTag[]; dropped: number; more: boolean }> {
  const redis = cacheConnection();
  const tags: PendingTag[] = [];
  let dropped = 0;
  let pops = 0;
  for (const [key, bulk] of [
    [pendingKey(agencyId), false],
    [bulkKey(agencyId), true],
  ] as const) {
    for (; pops < MAX_POPS && tags.length < CDN_PURGE_MAX_TAGS; pops++) {
      const popped = await redis.zpopmin(key, CDN_PURGE_MAX_TAGS - tags.length);
      if (popped.length === 0) break;
      for (let j = 0; j < popped.length; j += 2) {
        const tag = popped[j] as string;
        const at = Number(popped[j + 1]);
        if (!ageless(tag) && at < (tag.startsWith('c') ? portalCutoff : cutoff)) dropped++;
        else tags.push(bulk ? { tag, at, bulk } : { tag, at });
      }
    }
  }
  const [targeted, bulk] = await Promise.all([redis.zcard(pendingKey(agencyId)), redis.zcard(bulkKey(agencyId))]);
  return { tags, dropped, more: targeted + bulk > 0 };
}

/** Puts tags back after a failed purge, each into the set it came from (the retry takes them again). */
export async function returnPendingPurges(agencyId: string, tags: readonly PendingTag[]): Promise<void> {
  const strip = (t: PendingTag) => ({ tag: t.tag, at: t.at });
  await addPendingPurges(agencyId, tags.filter((t) => !t.bulk).map(strip));
  await addPendingPurges(agencyId, tags.filter((t) => t.bulk).map(strip), { bulk: true });
}

/** Drops the agency's pending tags (no edge cache to purge). */
export async function clearPendingPurges(agencyId: string): Promise<void> {
  await cacheConnection().del(pendingKey(agencyId), bulkKey(agencyId));
}

/** S15-F11 review: notes an agency portal change at `at` (keeps the later time). */
export async function markPortalAgencyChange(agencyId: string, at: number): Promise<void> {
  const key = agencyChangeKey(agencyId);
  await cacheConnection().multi().zadd(key, 'GT', at, 'at').expire(key, PENDING_TTL_SECONDS).exec();
}

/** S15-F11 review: the agency's last portal change (epoch ms), or null. */
export async function portalAgencyChangeAt(agencyId: string): Promise<number | null> {
  const score = await cacheConnection().zscore(agencyChangeKey(agencyId), 'at');
  return score === null ? null : Number(score);
}
