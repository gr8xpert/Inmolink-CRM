import {
  type ChatThreadDetailDto,
  CreateNetworkPostBody,
  type ListNetworkPostsQuery,
  NETWORK_CURRENCY,
  NETWORK_LIMITS,
  type NetworkPostDto,
  type NetworkPostKind,
  type NetworkPostPage,
  type NetworkReplyDto,
  NetworkSubscriptionBody,
  type NetworkSubscriptionDto,
  type NetworkSubscriptionList,
  ReplyNetworkPostBody,
  type TransactionType,
} from '@inmolink/contracts';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import type { Ctx } from '../../context';
import { idempotencyOf, keyReusedOn, replayOf } from '../../idempotency';
import { decodeCursor, toPage } from '../../pagination';
import * as agencies from '../agencies';
import * as chat from '../chat';
import * as compliance from '../compliance';
import * as taxonomy from '../taxonomy';
import { networkEvents } from './events';
import { assertCan } from './policy';
import * as repo from './repo';

/**
 * network board use cases (PATTERNS §7): `(ctx: Ctx, input) → DTO`. Posts are read under the caller's RLS — its own
 * agency's in every state, the network's while OPEN and unexpired (of listed agencies, for verified readers) — so a
 * post the caller may not read answers `NETWORK_POST_NOT_FOUND` like none. Notifying subscribers and matching a buyer
 * request against listings is the worker's, after commit (`matching.ts`).
 */

const DAY_MS = 86_400_000;

const userIdOf = (ctx: Ctx): string => {
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  return ctx.actor.userId;
};

const orNull = <T>(xs: readonly T[] | undefined): T[] | null => (xs && xs.length > 0 ? [...new Set(xs)] : null);

export function toPostDto(r: repo.PostRow, names: Map<string, string>, readerAgencyId: string): NetworkPostDto {
  return {
    id: r.id,
    kind: r.kind as NetworkPostKind,
    status: r.status as NetworkPostDto['status'],
    expired: r.expiresAt.getTime() <= clock.nowMs(),
    title: r.title,
    body: r.body,
    criteria: {
      transactionType: r.transactionType as TransactionType | null,
      propertyTypeIds: r.propertyTypeIds ?? [],
      locationIds: r.locationIds ?? [],
      featureIds: r.featureIds ?? [],
      priceMinCents: r.priceMinCents,
      priceMaxCents: r.priceMaxCents,
      currency: r.currency,
      bedsMin: r.bedsMin,
      bathsMin: r.bathsMin,
      areaMinM2: r.areaMinM2 === null ? null : Number(r.areaMinM2),
      areaMaxM2: r.areaMaxM2 === null ? null : Number(r.areaMaxM2),
    },
    agency: { id: r.agencyId, name: names.get(r.agencyId) ?? null },
    own: r.agencyId === readerAgencyId,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  };
}

const namesOf = (ctx: Ctx, rows: readonly repo.PostRow[]) =>
  agencies.directoryNamesOf(
    ctx.tx,
    rows.map((r) => r.agencyId),
  );

/**
 * `POST /v1/network/posts`: a post of the caller's agency (verified only: the network is for verified agencies),
 * on the board until `expiresInDays`. Its locations are kept with their ancestors (a subscription to a city matches a
 * post about one of its areas); an unknown location is refused. With an `Idempotency-Key`, a retry by the same member
 * within 24 h with the same body answers the first post; another body is `IDEMPOTENCY_KEY_REUSED`. ≤ 7 statements.
 */
export async function createPost(
  ctx: Ctx,
  raw: CreateNetworkPostBody,
  opts: { idempotencyKey?: string } = {},
): Promise<{ post: NetworkPostDto; replayed: boolean }> {
  assertCan(ctx, 'network.posts.write');
  agencies.assertVerified(ctx, 'network.board');
  const input = CreateNetworkPostBody.parse(raw);
  const me = userIdOf(ctx);
  const agencyId = ctx.tenant.agencyId;
  const now = clock.now();
  const idempotency = idempotencyOf('network.post', me, opts.idempotencyKey, input);
  const prior = await replayOf(
    ctx.tx,
    idempotency,
    (since, key) => repo.postByIdempotency(ctx.tx, agencyId, key.hash, since),
    { lock: true, now },
  );
  if (prior) return { post: toPostDto(prior.row, await namesOf(ctx, [prior.row]), agencyId), replayed: true };

  const c = input.criteria;
  const locationIds = orNull(c.locationIds);
  let scope: string[] | null = null;
  if (locationIds) {
    const lines = await taxonomy.locationLineages(ctx.tx, locationIds);
    if (locationIds.some((id) => !lines.has(id))) {
      throw new AppError('VALIDATION_FAILED', { field: 'criteria.locationIds', reason: 'unknown' });
    }
    scope = [...new Set(locationIds.flatMap((id) => [...(lines.get(id)?.values() ?? [])]))];
  }
  const id = newId();
  const row = await repo.insertPost(ctx.tx, {
    id,
    agencyId,
    kind: input.kind,
    title: input.title,
    body: input.body,
    transactionType: c.transactionType ?? null,
    propertyTypeIds: orNull(c.propertyTypeIds),
    locationIds,
    locationScopeIds: scope,
    featureIds: orNull(c.featureIds),
    priceMinCents: c.priceMinCents ?? null,
    priceMaxCents: c.priceMaxCents ?? null,
    // prices are compared with listings' euro prices (search documents)
    currency: NETWORK_CURRENCY,
    bedsMin: c.bedsMin ?? null,
    bathsMin: c.bathsMin ?? null,
    areaMinM2: c.areaMinM2 ?? null,
    areaMaxM2: c.areaMaxM2 ?? null,
    expiresAt: new Date(now.getTime() + input.expiresInDays * DAY_MS),
  });
  await repo
    .insertAuthor(ctx.tx, {
      agencyId,
      postId: id,
      createdByUserId: me,
      idempotencyHash: idempotency?.hash ?? null,
      requestHash: idempotency?.requestHash ?? null,
    })
    .catch(keyReusedOn('network_post_authors_idempotency_uq'));
  await emit(ctx.tx, networkEvents.postPublished({ postId: id, kind: input.kind }));
  // S12-F13: ids and kind only — the title and body are the agency's free text
  await compliance.audit(ctx, 'network.post.published', { type: 'networkPost', id }, { kind: input.kind });
  return { post: toPostDto(row, await namesOf(ctx, [row]), agencyId), replayed: false };
}

/**
 * `GET /v1/network/posts`: the board — open, unexpired posts of the network and the agency's own, newest first,
 * keyset (two queries: the page, the agencies' names); `mine`: the agency's own posts in every state.
 */
export async function listPosts(ctx: Ctx, query: ListNetworkPostsQuery): Promise<NetworkPostPage> {
  assertCan(ctx, 'network.posts.read');
  const q = { kind: query.kind, limit: query.limit, cursor: decodeCursor(query.cursor) };
  const rows = query.mine ? await repo.ownPosts(ctx.tx, ctx.tenant.agencyId, q) : await repo.board(ctx.tx, q);
  const names = await namesOf(ctx, rows.slice(0, query.limit));
  return toPage(
    rows,
    query.limit,
    (r) => ({ at: r.createdAt, id: r.id, atUs: r.atUs }),
    (r) => toPostDto(r, names, ctx.tenant.agencyId),
  );
}

async function readablePost(ctx: Ctx, id: string): Promise<repo.PostRow> {
  const row = await repo.getPost(ctx.tx, id);
  if (!row) throw new AppError('NETWORK_POST_NOT_FOUND');
  return row;
}

/** `GET /v1/network/posts/:id` (two queries). */
export async function getPost(ctx: Ctx, id: string): Promise<NetworkPostDto> {
  assertCan(ctx, 'network.posts.read');
  const row = await readablePost(ctx, id);
  return toPostDto(row, await namesOf(ctx, [row]), ctx.tenant.agencyId);
}

/**
 * `POST /v1/network/posts/:id/close`: the agency's post off the board (its author or an admin). Closing a closed post
 * answers it as it is. Reply threads stay open: the conversation is the agencies'. The close is audited
 * (`network.post.closed`, S12-F13); publishing too (`network.post.published`) — ids and kind, never title or body.
 */
export async function closePost(ctx: Ctx, id: string): Promise<NetworkPostDto> {
  assertCan(ctx, 'network.posts.read');
  const agencyId = ctx.tenant.agencyId;
  const row = await readablePost(ctx, id);
  if (row.agencyId !== agencyId) throw new AppError('NETWORK_POST_NOT_FOUND');
  assertCan(ctx, 'network.posts.close', { agencyId, authorUserId: await repo.authorOf(ctx.tx, agencyId, id) });
  // a concurrent close won: answer the post as it now is (and audit only the close this call made)
  const closed = row.status === 'OPEN' ? await repo.closePost(ctx.tx, agencyId, id) : null;
  if (closed) await compliance.audit(ctx, 'network.post.closed', { type: 'networkPost', id }, { kind: closed.kind });
  const result = closed ?? (await readablePost(ctx, id));
  return toPostDto(result, await namesOf(ctx, [result]), agencyId);
}

/**
 * `POST /v1/network/posts/:id/replies`: the caller's agency answers another agency's open post — its `NETWORK` chat
 * thread with the poster (created on the first reply, with the poster's copy and the post's author seated; joined
 * after) and the caller's message in it (`clientKey` replays a retried send). The poster learns of it through chat
 * (`CHAT_MESSAGE`). An expired or closed post takes no reply (`NETWORK_POST_CLOSED`; another agency's is not even
 * readable: `NETWORK_POST_NOT_FOUND`).
 */
export async function replyToPost(ctx: Ctx, id: string, raw: ReplyNetworkPostBody): Promise<NetworkReplyDto> {
  assertCan(ctx, 'network.posts.write');
  agencies.assertVerified(ctx, 'network.board');
  const body = ReplyNetworkPostBody.parse(raw);
  const row = await readablePost(ctx, id);
  if (row.agencyId === ctx.tenant.agencyId) throw new AppError('VALIDATION_FAILED', { reason: 'own_post' });
  if (row.status !== 'OPEN' || row.expiresAt.getTime() <= clock.nowMs()) throw new AppError('NETWORK_POST_CLOSED');
  return chat.replyInNetworkThread(ctx, { postId: row.id, posterAgencyId: row.agencyId, message: body });
}

/**
 * `POST /v1/network/threads/:id/join`: an admin of the agency joins one of its reply threads (on the post's side, where
 * the author — or, when they left, the admins — were seated; on the replying side, colleagues join by replying).
 */
export async function joinReplyThread(ctx: Ctx, threadId: string): Promise<ChatThreadDetailDto> {
  assertCan(ctx, 'network.threads.join');
  return chat.joinNetworkThread(ctx, threadId);
}

/* ------------------------------------------------------------------ subscriptions */

function toSubscriptionDto(r: repo.SubscriptionRow): NetworkSubscriptionDto {
  return {
    id: r.id,
    name: r.name,
    kinds: (r.kinds ?? []) as NetworkPostKind[],
    transactionType: r.transactionType as TransactionType | null,
    propertyTypeIds: r.propertyTypeIds ?? [],
    locationIds: r.locationIds ?? [],
    priceMinCents: r.priceMinCents,
    priceMaxCents: r.priceMaxCents,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function subscriptionFields(raw: NetworkSubscriptionBody): repo.SubscriptionFields {
  const s = NetworkSubscriptionBody.parse(raw);
  return {
    name: s.name,
    kinds: orNull(s.kinds),
    transactionType: s.transactionType ?? null,
    propertyTypeIds: orNull(s.propertyTypeIds),
    locationIds: orNull(s.locationIds),
    priceMinCents: s.priceMinCents ?? null,
    priceMaxCents: s.priceMaxCents ?? null,
  };
}

/** `GET /v1/network/subscriptions`: the caller's own, oldest first (one query). */
export async function listSubscriptions(ctx: Ctx): Promise<NetworkSubscriptionList> {
  assertCan(ctx, 'network.subscriptions.manage');
  const rows = await repo.subscriptionsOf(
    ctx.tx,
    ctx.tenant.agencyId,
    userIdOf(ctx),
    NETWORK_LIMITS.subscriptionsPerUser,
  );
  return { items: rows.map(toSubscriptionDto) };
}

/** `POST /v1/network/subscriptions`: at most `subscriptionsPerUser` per member (`NETWORK_SUBSCRIPTION_LIMIT`). */
export async function createSubscription(ctx: Ctx, raw: NetworkSubscriptionBody): Promise<NetworkSubscriptionDto> {
  assertCan(ctx, 'network.subscriptions.manage');
  const fields = subscriptionFields(raw);
  const row = await repo.insertSubscription(ctx.tx, {
    ...fields,
    agencyId: ctx.tenant.agencyId,
    id: newId(),
    userId: userIdOf(ctx),
    max: NETWORK_LIMITS.subscriptionsPerUser,
  });
  if (!row) throw new AppError('NETWORK_SUBSCRIPTION_LIMIT', { max: NETWORK_LIMITS.subscriptionsPerUser });
  return toSubscriptionDto(row);
}

/** `PUT /v1/network/subscriptions/:id`: the caller's subscription, all filters replaced. */
export async function updateSubscription(
  ctx: Ctx,
  id: string,
  raw: NetworkSubscriptionBody,
): Promise<NetworkSubscriptionDto> {
  assertCan(ctx, 'network.subscriptions.manage');
  const row = await repo.updateSubscription(ctx.tx, ctx.tenant.agencyId, userIdOf(ctx), id, subscriptionFields(raw));
  if (!row) throw new AppError('NETWORK_SUBSCRIPTION_NOT_FOUND');
  return toSubscriptionDto(row);
}

/** `DELETE /v1/network/subscriptions/:id`. */
export async function deleteSubscription(ctx: Ctx, id: string): Promise<void> {
  assertCan(ctx, 'network.subscriptions.manage');
  if (!(await repo.deleteSubscription(ctx.tx, ctx.tenant.agencyId, userIdOf(ctx), id))) {
    throw new AppError('NETWORK_SUBSCRIPTION_NOT_FOUND');
  }
}
