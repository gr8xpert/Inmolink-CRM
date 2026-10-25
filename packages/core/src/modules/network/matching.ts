import { NETWORK_LIMITS, NOTIFICATION_LIMITS, NotificationParams } from '@inmolink/contracts';
import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { createLogger, type Logger } from '@inmolink/platform/logger';
import { emit } from '@inmolink/platform/outbox';
import type { SearchEngine } from '@inmolink/platform/search';
import * as agencies from '../agencies';
import * as chat from '../chat';
import * as identity from '../identity';
import * as notifications from '../notifications';
import * as properties from '../properties';
import * as search from '../search';
import { networkEvents } from './events';
import * as repo from './repo';

/**
 * network board worker side (app_system, PATTERNS §12): a new post notifies the members of other agencies whose
 * subscriptions match it, a buyer request is matched against the other agencies' listings, and expired posts are
 * closed. All idempotent — each recipient's notification carries `sourceKey` = the post (+ purpose) and `at` = the
 * post's time, so a retried job raises nothing twice — and batched (one short transaction per ~100 agencies). Only
 * agencies taking part in the network (listed: VERIFIED) are notified, and nothing of a post but its kind and title
 * (what its agency published) goes into a notification.
 */

/** Agencies whose subscribers are notified per transaction. */
export const SUBSCRIBER_AGENCY_BATCH = 100;
/** Members read per batch at most (≤ 20 subscriptions each: a bound, not a page). */
export const SUBSCRIBER_ROWS_MAX = 50_000;
/** Matched agencies notified per transaction. */
export const MATCH_AGENCY_BATCH = 100;
/** Expired posts closed per statement, and statements per sweep run. */
export const EXPIRY_BATCH = 500;
export const EXPIRY_BATCHES_PER_RUN = 20;

export const postLink = (postId: string) => `/network/posts/${postId}`;
export const matchSourceKey = (postId: string) => `network.match:${postId}`;

let log: Logger | undefined;
const logger = () => {
  log ??= createLogger({ service: 'network' });
  return log;
};

const safeRefs = (refs: string) => (NotificationParams.safeParse({ refs }).success ? refs : '');

const isLive = (p: repo.PostRow) => p.status === 'OPEN' && p.expiresAt.getTime() > clock.nowMs();

const chunks = <T>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** The post and its agency's directory name, while it is on the board and its agency takes part in the network. */
async function livePost(postId: string, reason: string) {
  return withSystem(reason, async (tx) => {
    const post = await repo.postById(tx, postId);
    if (!post || !isLive(post)) return null;
    const names = await agencies.listedAgencyNamesOf(tx, [post.agencyId]);
    const poster = names.get(post.agencyId);
    return poster === undefined ? null : { post, poster };
  });
}

/**
 * `network.notifySubscribers` (one per published post; for a buyer request, after its matching): every member of
 * another agency with a subscription matching the post gets one `NETWORK_POST` notification (several matching
 * subscriptions: still one) — unless the buyer request's `NETWORK_MATCH` told them already. One transaction per
 * `SUBSCRIBER_AGENCY_BATCH` agencies: their members (one statement), the listed agencies among them, the members told
 * of a match, and one batched raise for all of them (`raiseNotificationsAcross`).
 */
export async function notifySubscribers(postId: string): Promise<{ notified: number }> {
  const live = await livePost(postId, `network.notifySubscribers: post ${postId}`);
  if (!live) return { notified: 0 };
  const { post, poster } = live;
  let after: string | null = null;
  let notified = 0;
  for (;;) {
    const lastAgency: string | null = await withSystem(`network.notifySubscribers: post ${postId}`, async (tx) => {
      const rows = await repo.matchingSubscribers(tx, post, after, SUBSCRIBER_AGENCY_BATCH, SUBSCRIBER_ROWS_MAX);
      if (rows.length === SUBSCRIBER_ROWS_MAX) {
        logger().warn({ postId, rows: rows.length }, 'network subscribers: batch at its row bound');
      }
      const byAgency = new Map<string, string[]>();
      for (const r of rows) byAgency.set(r.agencyId, [...(byAgency.get(r.agencyId) ?? []), r.userId]);
      const agencyIds = [...byAgency.keys()];
      const listed = await agencies.listedAgencyNamesOf(tx, agencyIds);
      const matched =
        post.kind === 'BUYER_REQUEST'
          ? await notifications.recipientsOfSource(tx, {
              agencyIds,
              type: 'NETWORK_MATCH',
              sourceKey: matchSourceKey(post.id),
              at: post.createdAt,
            })
          : new Set<string>();
      const items = [...byAgency].flatMap(([agencyId, users]) =>
        listed.has(agencyId)
          ? chunks(
              users.filter((u) => !matched.has(`${agencyId}:${u}`)),
              NOTIFICATION_LIMITS.recipients,
            ).map((userIds) => ({
              agencyId,
              userIds,
              params: { actor: poster, subject: post.title, kind: post.kind },
              link: postLink(post.id),
              sourceKey: `network.post:${post.id}`,
              at: post.createdAt,
            }))
          : [],
      );
      notified += (await notifications.raiseNotificationsAcross(tx, 'NETWORK_POST', items)).notified.length;
      return agencyIds.length < SUBSCRIBER_AGENCY_BATCH ? null : (agencyIds.at(-1) ?? null);
    });
    if (lastAgency === null) break;
    after = lastAgency;
  }
  return { notified };
}

/**
 * `network.matchBuyerRequest` (one per published `BUYER_REQUEST`): the other agencies whose ACTIVE listings match the
 * request's criteria (`search.matchListingOwners`, over the engine, outside any transaction — every owner, in rounds)
 * are told once each — one `NETWORK_MATCH` for the agents responsible for the matched listings who are active members
 * (else the agency's admins), with how many match and their references (up to `matchRefsPerAgency`). The asker learns
 * nothing of it (white label: an agency replies if it wants to). One transaction per `MATCH_AGENCY_BATCH` agencies:
 * listed agencies, listing agents, active members, admins and the batched raise (`raiseNotificationsAcross`: a few
 * statements whatever the number of agencies).
 */
export async function matchBuyerRequest(
  postId: string,
  options: { engine?: SearchEngine } = {},
): Promise<{ agencies: number; notified: number; truncated: boolean }> {
  const live = await livePost(postId, `network.matchBuyerRequest: post ${postId}`);
  if (!live || live.post.kind !== 'BUYER_REQUEST') return { agencies: 0, notified: 0, truncated: false };
  const { post, poster } = live;
  const opt = <T>(v: T | null) => (v === null ? undefined : v);
  const { owners, truncated } = await search.matchListingOwners(
    {
      transactionType: opt(post.transactionType),
      propertyTypeIds: opt(post.propertyTypeIds),
      locationIds: opt(post.locationIds),
      featureIds: opt(post.featureIds),
      priceMinCents: opt(post.priceMinCents),
      priceMaxCents: opt(post.priceMaxCents),
      bedsMin: opt(post.bedsMin),
      bathsMin: opt(post.bathsMin),
      areaMinM2: post.areaMinM2 === null ? undefined : Number(post.areaMinM2),
      areaMaxM2: post.areaMaxM2 === null ? undefined : Number(post.areaMaxM2),
    },
    { excludeAgencyId: post.agencyId, perAgency: NETWORK_LIMITS.matchRefsPerAgency, engine: options.engine },
  );
  let told = 0;
  let notified = 0;
  for (const batch of chunks(owners, MATCH_AGENCY_BATCH)) {
    await withSystem(`network.matchBuyerRequest: post ${postId}`, async (tx) => {
      const listed = await agencies.listedAgencyNamesOf(
        tx,
        batch.map((m) => m.agencyId),
      );
      const rows = await properties.listingAgentsOf(
        tx,
        batch.flatMap((m) => m.listingIds),
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      // the index may lag a deleted or transferred listing: only the agency's own rows count
      const plan = batch
        .filter((m) => listed.has(m.agencyId))
        .map((m) => {
          const own = m.listingIds.flatMap((id) => {
            const r = byId.get(id);
            return r && r.agencyId === m.agencyId ? [r] : [];
          });
          const agents = [...new Set(own.flatMap((r) => (r.ownerUserId ? [r.ownerUserId] : [])))];
          return { match: m, own, agents };
        });
      const active = await identity.activeClientMembersAcross(
        tx,
        plan.flatMap((p) => p.agents.map((userId) => ({ agencyId: p.match.agencyId, userId }))),
      );
      const withAgents = plan.map((p) => ({
        ...p,
        agents: p.agents.filter((u) => active.has(`${p.match.agencyId}:${u}`)),
      }));
      const admins = await identity.agencyAdminsOf(
        tx,
        withAgents.filter((p) => p.agents.length === 0).map((p) => p.match.agencyId),
      );
      const items = withAgents.flatMap(({ match, own, agents }) => {
        const userIds = (agents.length > 0 ? agents : (admins.get(match.agencyId) ?? [])).slice(
          0,
          NOTIFICATION_LIMITS.recipients,
        );
        if (userIds.length === 0) return [];
        const refs = own
          .map((r) => r.ref)
          .join(', ')
          .slice(0, NOTIFICATION_LIMITS.paramChars);
        return [
          {
            agencyId: match.agencyId,
            userIds,
            // a reference list that reads like a phone number is left out rather than failing the job
            params: { actor: poster, subject: post.title, count: match.count, refs: safeRefs(refs) },
            link: postLink(post.id),
            sourceKey: matchSourceKey(post.id),
            at: post.createdAt,
          },
        ];
      });
      told += items.length;
      notified += (await notifications.raiseNotificationsAcross(tx, 'NETWORK_MATCH', items)).notified.length;
    });
  }
  return { agencies: told, notified, truncated };
}

/**
 * `network.closePostThreads` (one per `network.post.closed`, S12-F12): its reply threads become read-only, both
 * copies, `chat.NETWORK_CLOSE_BATCH` threads per transaction. Each transaction re-reads the post — CLOSED and of the
 * event's agency, else nothing (a closed post is never reopened) — before closing.
 */
export async function closePostThreads(p: { postId: string; agencyId: string }): Promise<{ closed: number }> {
  let closed = 0;
  for (;;) {
    const r = await withSystem(`network.closePostThreads: ${p.postId}`, async (tx) => {
      const post = await repo.postById(tx, p.postId);
      if (post?.status !== 'CLOSED' || post.agencyId !== p.agencyId) return null;
      return chat.closeNetworkThreadsForWorker(tx, post.agencyId, post.id);
    });
    if (!r) return { closed };
    closed += r.copies;
    if (r.threads < chat.NETWORK_CLOSE_BATCH) return { closed };
  }
}

/**
 * `network.closeExpiredPosts` (every 15 minutes): OPEN posts past their expiry become CLOSED, the longest expired first,
 * `EXPIRY_BATCH` per transaction and at most `EXPIRY_BATCHES_PER_RUN` a run (the next run takes the rest), each with its
 * `network.post.closed` event. Idempotent.
 */
export async function closeExpiredPosts(): Promise<{ closed: number }> {
  let closed = 0;
  for (let i = 0; i < EXPIRY_BATCHES_PER_RUN; i++) {
    const ids = await withSystem('network.closeExpiredPosts', async (tx) => {
      const posts = await repo.closeExpiredPosts(tx, EXPIRY_BATCH);
      // S12-F12: each closed post's reply threads become read-only (one event per post, in the close's transaction)
      await emit(
        tx,
        posts.map((p) => networkEvents.postClosed({ postId: p.id, agencyId: p.agencyId })),
      );
      return posts;
    });
    closed += ids.length;
    if (ids.length < EXPIRY_BATCH) break;
  }
  return { closed };
}
