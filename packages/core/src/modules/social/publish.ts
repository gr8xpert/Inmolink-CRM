import { type Tx, withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { emit } from '@inmolink/platform/outbox';
import { compileOwner, NO_OWNER, plainText } from '../../white-label';
import * as agencies from '../agencies';
import * as media from '../media';
import * as properties from '../properties';
import { metaApp, pageTokenCipher, socialConfig } from './config';
import { socialEvents } from './events';
import { MetaError, MetaGraphClient } from './meta';
import * as repo from './repo';

/**
 * Publishing scheduled posts (S12-07): published **once**, at the scheduled time.
 *
 * 1. `social.sweepDuePosts` (pool `social`, every minute) claims due SCHEDULED posts (`FOR UPDATE SKIP LOCKED`, at most
 *    `SWEEP.perAgency` of one agency per pass): PUBLISHING with `claimed_at`, and one `social.post.due` event each in
 *    the claiming transaction.
 * 2. `social.publishPost` (job ID = post + claim time) checks the claim, marks `publish_started_at` and commits **before**
 *    it calls Meta (no transaction is open during the call). A job that finds `publish_started_at` already set (its
 *    previous attempt died during the call) does not call Meta again: the post fails as `OUTCOME_UNKNOWN` (the member
 *    checks the Page). A redelivered event or a job that runs twice finds the claim gone and does nothing.
 * 3. The outcome: PUBLISHED with Meta's id; or a definite refusal — FAILED with Meta's code and message; or a
 *    retryable one (rate limit, outage, before anything was posted) — back to SCHEDULED a little later, at most
 *    `MAX_ATTEMPTS` times; an ambiguous one (timeout on the publishing call) — FAILED `OUTCOME_UNKNOWN`. An expired or
 *    revoked token marks the account NEEDS_RECONNECT (`social.account.needsReconnect` → the admins' notification).
 *
 * White label: a network listing's caption is cleaned of its owner's identity (names, contacts, website, reference)
 * and of any e-mail address, URL or phone number before it publishes.
 */

export const SWEEP = { batch: 100, perAgency: 10 } as const;
/** Publishing attempts of one post (retryable failures only). */
export const MAX_ATTEMPTS = 3;
/**
 * An attempt that marked `publish_started_at` less than this long ago may still be calling Meta (longer than the job's
 * timeout): a duplicate job skips the post. Older, the attempt died — the post fails as OUTCOME_UNKNOWN.
 */
export const IN_FLIGHT_MS = 10 * 60_000;
/** Back-off before a retryable failure's next attempt: 2, 4, 8 … minutes. */
const retryDelayMs = (attempts: number) => 2 ** attempts * 60_000;

export async function sweepDuePosts(opts: { now?: Date } = {}): Promise<{ claimed: number }> {
  const now = opts.now ?? clock.now();
  return withSystem('social.sweepDuePosts', async (tx) => {
    // Claims whose job died: settled first (unknown outcome, or due again).
    await repo.settleStaleClaims(tx, new Date(now.getTime() - IN_FLIGHT_MS), now);
    const claimed = await repo.claimDuePosts(tx, now, SWEEP.batch, SWEEP.perAgency);
    for (const c of claimed) {
      await emit(tx, socialEvents.postDue({ postId: c.id, agencyId: c.agencyId, claimedAtMs: c.claimedAt.getTime() }));
    }
    return { claimed: claimed.length };
  });
}

export type PublishOutcome =
  | 'PUBLISHED'
  | 'FAILED'
  | 'RETRY_SCHEDULED'
  | 'OUTCOME_UNKNOWN'
  | 'ACCOUNT_NEEDS_RECONNECT'
  | 'SKIPPED';

interface Prepared {
  platform: repo.SocialPlatform;
  externalId: string;
  token: string;
  caption: string;
  imageUrls: string[];
  attempts: number;
}

type Prep = { kind: 'go'; p: Prepared } | { kind: 'done'; outcome: PublishOutcome };

/** The post's publish: see the header. Idempotent per claim. */
export async function publishPost(input: { postId: string; agencyId: string; claimedAtMs: number }): Promise<{
  outcome: PublishOutcome;
}> {
  const prep = await withSystem(`social.publishPost: post ${input.postId}`, (tx) => prepare(tx, input));
  if (prep.kind === 'done') return { outcome: prep.outcome };
  const app = metaApp();
  if (!app) {
    return { outcome: await finish(input.postId, { kind: 'failed', code: 'NOT_CONFIGURED', message: null }) };
  }
  const client = new MetaGraphClient(app, socialConfig().fetchOptions);
  try {
    const post = { caption: prep.p.caption, imageUrls: prep.p.imageUrls };
    const { externalId } =
      prep.p.platform === 'FACEBOOK_PAGE'
        ? await client.publishFacebook(prep.p.externalId, prep.p.token, post)
        : await client.publishInstagram(prep.p.externalId, prep.p.token, post);
    return { outcome: await finish(input.postId, { kind: 'published', externalId }) };
  } catch (err) {
    if (!(err instanceof MetaError)) throw err;
    return { outcome: await finish(input.postId, failureOf(err, prep.p.attempts)) };
  }
}

type Finish =
  | { kind: 'published'; externalId: string }
  | { kind: 'failed'; code: string; message: string | null }
  | { kind: 'retry'; code: string; message: string; attempts: number }
  | { kind: 'reconnect'; message: string };

function failureOf(err: MetaError, attempts: number): Finish {
  if (err.kind === 'TOKEN_EXPIRED') return { kind: 'reconnect', message: err.message };
  if (err.ambiguous) return { kind: 'failed', code: 'OUTCOME_UNKNOWN', message: err.message };
  if (err.retryable && attempts < MAX_ATTEMPTS) {
    return { kind: 'retry', code: err.kind, message: err.message, attempts };
  }
  return { kind: 'failed', code: err.kind, message: err.message };
}

async function prepare(tx: Tx, input: { postId: string; agencyId: string; claimedAtMs: number }): Promise<Prep> {
  const post = await repo.lockPost(tx, input.postId);
  // Not this claim's any more (done, cancelled, claimed again): nothing to do.
  if (
    !post ||
    post.agencyId !== input.agencyId ||
    post.status !== 'PUBLISHING' ||
    post.claimedAt?.getTime() !== input.claimedAtMs
  ) {
    return { kind: 'done', outcome: 'SKIPPED' };
  }
  const now = clock.now();
  const fail = async (code: string, message: string | null = null): Promise<Prep> => {
    await repo.setPostState(tx, post.id, { status: 'FAILED', errorCode: code, errorMessage: message }, now);
    return { kind: 'done', outcome: code === 'OUTCOME_UNKNOWN' ? 'OUTCOME_UNKNOWN' : 'FAILED' };
  };
  if (post.publishStartedAt) {
    // Another attempt is calling Meta right now (a duplicate job): leave it be.
    if (now.getTime() - post.publishStartedAt.getTime() < IN_FLIGHT_MS) return { kind: 'done', outcome: 'SKIPPED' };
    // A previous attempt died while it was calling Meta: the post may be live. Never post twice.
    return fail('OUTCOME_UNKNOWN');
  }
  const account = await repo.accountWithTokens(tx, post.accountId);
  if (!account || account.agencyId !== post.agencyId) return fail('ACCOUNT_NOT_FOUND');
  if (account.status !== 'ACTIVE') {
    await repo.setPostState(
      tx,
      post.id,
      { status: 'FAILED', errorCode: 'ACCOUNT_NEEDS_RECONNECT', errorMessage: null },
      now,
    );
    return { kind: 'done', outcome: 'ACCOUNT_NEEDS_RECONNECT' };
  }
  const [listing] = await properties.listingsForReadModels(tx, [post.listingId]);
  if (listing?.visibility !== 'PUBLIC' || listing.status !== 'ACTIVE') return fail('LISTING_UNAVAILABLE');
  const base = socialConfig().mediaBaseUrl;
  if (!base) return fail('NOT_CONFIGURED');
  const keys = new Map(
    (await media.listingSocialImages(tx, listing.id, listing.agencyId)).map((i) => [i.mediaId, i.key] as const),
  );
  const imageUrls = post.mediaIds
    .map((id) => keys.get(id))
    .filter((k): k is string => typeof k === 'string')
    .map((k) => `${base.replace(/\/+$/, '')}/${k}`);
  if (imageUrls.length === 0) return fail('NO_IMAGES');
  const typed = post.caption ?? post.captions.find((c) => c.locale === post.locale)?.text ?? '';
  const caption = await whiteLabelled(tx, typed, listing, post.agencyId);
  const attempts = post.attempts + 1;
  await repo.setPostState(tx, post.id, { publishStartedAt: now, attempts }, now);
  return {
    kind: 'go',
    p: {
      platform: account.platform,
      externalId: account.externalId,
      token: pageTokenCipher.decrypt(account.agencyId, account.id, account.tokenEnc),
      caption,
      imageUrls,
      attempts,
    },
  };
}

/**
 * A caption as it may publish (white label, S12-07): any e-mail address, URL or phone number goes; for another
 * agency's listing its identity (names, contacts, website) and own reference go too.
 */
export async function whiteLabelled(
  tx: Tx,
  text: string,
  listing: { agencyId: string; ref: string },
  postingAgencyId: string,
): Promise<string> {
  if (!text) return text;
  const network = listing.agencyId !== postingAgencyId;
  const owner = network
    ? ((await agencies.ownerIdentities(tx, [listing.agencyId])).get(listing.agencyId) ?? NO_OWNER)
    : NO_OWNER;
  return compileOwner(owner).clean(plainText(text), network ? [listing.ref] : []);
}

async function finish(postId: string, f: Finish): Promise<PublishOutcome> {
  return withSystem(`social.publishPost: outcome of ${postId}`, async (tx) => {
    const now = clock.now();
    // Only this attempt's post: still PUBLISHING (a later sweep or a member's change otherwise decided).
    const current = await repo.lockPost(tx, postId);
    if (current?.status !== 'PUBLISHING') return 'SKIPPED';
    switch (f.kind) {
      case 'published':
        await repo.setPostState(
          tx,
          postId,
          { status: 'PUBLISHED', externalPostId: f.externalId, publishedAt: now, errorCode: null, errorMessage: null },
          now,
        );
        return 'PUBLISHED';
      case 'failed':
        await repo.setPostState(tx, postId, { status: 'FAILED', errorCode: f.code, errorMessage: f.message }, now);
        return f.code === 'OUTCOME_UNKNOWN' ? 'OUTCOME_UNKNOWN' : 'FAILED';
      case 'retry':
        // Nothing was posted: the sweep takes it again later (a new claim, a new job).
        await repo.setPostState(
          tx,
          postId,
          {
            status: 'SCHEDULED',
            scheduledAt: new Date(now.getTime() + retryDelayMs(f.attempts)),
            claimedAt: null,
            publishStartedAt: null,
            errorCode: f.code,
            errorMessage: f.message,
          },
          now,
        );
        return 'RETRY_SCHEDULED';
      case 'reconnect': {
        const post = current;
        await repo.setPostState(
          tx,
          postId,
          { status: 'FAILED', errorCode: 'ACCOUNT_NEEDS_RECONNECT', errorMessage: f.message },
          now,
        );
        if (post) await needsReconnect(tx, post.accountId, post.agencyId, 'TOKEN_EXPIRED', now);
        return 'ACCOUNT_NEEDS_RECONNECT';
      }
    }
  });
}

/** Marks the account and announces it (once: only the call that changed the status emits the event). */
export async function needsReconnect(
  tx: Tx,
  accountId: string,
  agencyId: string,
  reason: string,
  now: Date,
): Promise<boolean> {
  if (!(await repo.markNeedsReconnect(tx, accountId, reason, now))) return false;
  await emit(tx, socialEvents.accountNeedsReconnect({ accountId, agencyId, reason }));
  return true;
}
