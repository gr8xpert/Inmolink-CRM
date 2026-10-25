/**
 * Social posting use cases (S12-07, PLAN §3 #58, §7 M25): `(ctx, input) → DTO`. Authorized with `assertCan`, behind
 * the `social.posting` feature flag (per agency; off by default — real Meta access waits on H3). The worker side
 * (publishing, token checks, captions) is in `publish.ts`, `accounts.ts` and `captions.ts`.
 *
 * Connecting is the one use case that talks to Meta during the request (an OAuth hand-shake cannot wait for a job): it
 * runs as three steps — check (a short transaction), the code exchange with Meta (no transaction open), then the
 * write (a short transaction) — through a `CtxRunner`, like uploads.
 */
import { randomBytes } from 'node:crypto';
import type {
  CompleteSocialConnectBody,
  CreateSocialPostBody,
  ListSocialPostsQuery,
  RequestSocialCaptionsBody,
  SocialAccountDto,
  SocialAccountList,
  SocialPostDto,
  SocialPostPage,
  StartSocialConnectDto,
  UpdateSocialPostBody,
} from '@inmolink/contracts';
import { SOCIAL_LIMITS } from '@inmolink/contracts';
import { clock } from '@inmolink/platform/clock';
import { safeEqual } from '@inmolink/platform/crypto';
import { AppError } from '@inmolink/platform/errors';
import { type FlagCtx, flag } from '@inmolink/platform/flags';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import type { Ctx, CtxRunner } from '../../context';
import { decodeCursor, toPage } from '../../pagination';
import * as compliance from '../compliance';
import * as media from '../media';
import * as properties from '../properties';
import { metaApp, pageTokenCipher, socialConfig, stateMac, userTokenCipher } from './config';
import { socialEvents } from './events';
import { MetaError, MetaGraphClient, type MetaPage } from './meta';
import { assertCan } from './policy';
import * as repo from './repo';

/** The feature flag of social posting (per agency). */
export const SOCIAL_FLAG = 'social.posting';
/** At most this many connected accounts per agency (Pages and Instagram accounts together). */
export const MAX_ACCOUNTS = 50;
/** How long a connect `state` stays valid: the member logs in at Meta and comes straight back. */
export const CONNECT_STATE_TTL_MS = 10 * 60_000;

const EDITABLE: ReadonlySet<repo.SocialPostStatus> = new Set(['DRAFT', 'SCHEDULED']);

async function assertEnabled(ctx: FlagCtx): Promise<void> {
  if (!(await flag(ctx, SOCIAL_FLAG))) throw new AppError('SOCIAL_NOT_ENABLED', { reason: 'flag' });
}

function meta(): MetaGraphClient {
  const app = metaApp();
  if (!app) throw new AppError('SOCIAL_NOT_ENABLED', { reason: 'not_configured' });
  return new MetaGraphClient(app, socialConfig().fetchOptions);
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toAccountDto(row: repo.AccountRow): SocialAccountDto {
  return {
    id: row.id,
    platform: row.platform,
    externalId: row.externalId,
    name: row.name,
    status: row.status,
    statusReason: row.statusReason,
    tokenExpiresAt: iso(row.tokenExpiresAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toPostDto(row: repo.PostRow, platform: repo.SocialPlatform): SocialPostDto {
  return {
    id: row.id,
    accountId: row.accountId,
    platform,
    listingId: row.listingId,
    status: row.status,
    locale: row.locale,
    caption: row.caption,
    captions: row.captions,
    captionStatus: row.captionStatus,
    mediaIds: row.mediaIds,
    scheduledAt: iso(row.scheduledAt),
    publishedAt: iso(row.publishedAt),
    externalPostId: row.externalPostId,
    attempts: row.attempts,
    error: row.errorCode ? { code: row.errorCode, message: row.errorMessage } : null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── Accounts ─────────────────────────────────────────────────────────────────────────────────────────

export async function listSocialAccounts(ctx: Ctx): Promise<SocialAccountList> {
  assertCan(ctx, 'social.read');
  await assertEnabled(ctx);
  const rows = await repo.listAccounts(ctx.tx, ctx.tenant.agencyId, MAX_ACCOUNTS);
  return { items: rows.map(toAccountDto) };
}

interface StatePayload {
  /** Agency, member, nonce, expiry (epoch ms). */
  a: string;
  u: string;
  n: string;
  e: number;
}

function signState(p: StatePayload): string {
  const encoded = Buffer.from(JSON.stringify(p)).toString('base64url');
  return `${encoded}.${stateMac(encoded)}`;
}

/** The state's payload when it is genuine, unexpired and this member's of this agency; null otherwise. */
function openState(ctx: Ctx, state: string): StatePayload | null {
  const [encoded, mac, extra] = state.split('.');
  if (!encoded || !mac || extra !== undefined || !safeEqual(stateMac(encoded), mac)) return null;
  try {
    const p = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as StatePayload;
    const now = clock.now().getTime();
    const userId = ctx.actor.kind === 'user' ? ctx.actor.userId : null;
    if (p.a !== ctx.tenant.agencyId || p.u !== userId) return null;
    if (typeof p.e !== 'number' || p.e <= now || p.e > now + CONNECT_STATE_TTL_MS) return null;
    return p;
  } catch {
    return null;
  }
}

/** `POST /v1/social/connect`: Meta's login dialog with a state signed for this member and agency (10 minutes). */
export async function startSocialConnect(ctx: Ctx): Promise<StartSocialConnectDto> {
  assertCan(ctx, 'social.manage');
  await assertEnabled(ctx);
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  const client = meta();
  const state = signState({
    a: ctx.tenant.agencyId,
    u: ctx.actor.userId,
    n: randomBytes(12).toString('base64url'),
    e: clock.now().getTime() + CONNECT_STATE_TTL_MS,
  });
  return { url: client.dialogUrl(state) };
}

/** Meta's answer to the code exchange as the use case's error. */
function connectError(err: unknown): never {
  if (err instanceof MetaError) {
    if (err.kind === 'NETWORK' || err.kind === 'UNAVAILABLE' || err.kind === 'RATE_LIMITED') {
      throw new AppError('SOCIAL_PROVIDER_UNAVAILABLE');
    }
    throw new AppError('SOCIAL_CONNECT_FAILED', { reason: 'exchange' });
  }
  throw err;
}

/**
 * `POST /v1/social/connect/callback`: the code Meta sent back becomes a long-lived user token and the Pages it manages
 * (with their Instagram Business accounts); each is stored with its token encrypted — a Page connected again is
 * updated, and becomes ACTIVE again. Audited (`social.account.connected`, ids and platforms only).
 */
export async function completeSocialConnect(
  run: CtxRunner,
  input: CompleteSocialConnectBody,
): Promise<SocialAccountList> {
  const client = await run(async (ctx) => {
    assertCan(ctx, 'social.manage');
    await assertEnabled(ctx);
    if (!openState(ctx, input.state)) throw new AppError('SOCIAL_CONNECT_FAILED', { reason: 'state' });
    return meta();
  });
  let userToken: { accessToken: string; expiresIn: number | null };
  let pages: MetaPage[];
  try {
    userToken = await client.userTokenFromCode(input.code);
    pages = await client.pages(userToken.accessToken);
  } catch (err) {
    connectError(err);
  }
  if (pages.length === 0) throw new AppError('SOCIAL_CONNECT_FAILED', { reason: 'no_pages' });
  return run(async (ctx) => {
    assertCan(ctx, 'social.manage');
    if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
    const { agencyId } = ctx.tenant;
    const now = clock.now();
    const expiresAt = userToken.expiresIn ? new Date(now.getTime() + userToken.expiresIn * 1_000) : null;
    const wanted = pages.flatMap((p) => [
      { platform: 'FACEBOOK_PAGE' as const, externalId: p.id, pageId: null, name: p.name, token: p.accessToken },
      ...(p.instagram
        ? [
            {
              platform: 'INSTAGRAM_BUSINESS' as const,
              externalId: p.instagram.id,
              pageId: p.id,
              name: p.instagram.username,
              token: p.accessToken,
            },
          ]
        : []),
    ]);
    const existing = await repo.accountIdsByExternal(ctx.tx, agencyId, wanted);
    const added = wanted.filter((w) => !existing.has(`${w.platform}:${w.externalId}`)).length;
    if ((await repo.countAccounts(ctx.tx, agencyId)) + added > MAX_ACCOUNTS) {
      throw new AppError('VALIDATION_FAILED', { reason: 'account_limit', limit: MAX_ACCOUNTS });
    }
    for (const w of wanted) {
      const id = existing.get(`${w.platform}:${w.externalId}`) ?? newId();
      await repo.upsertAccount(
        ctx.tx,
        {
          id,
          agencyId,
          platform: w.platform,
          externalId: w.externalId,
          pageId: w.pageId,
          name: w.name,
          tokenEnc: pageTokenCipher.encrypt(agencyId, id, w.token),
          userTokenEnc: userTokenCipher.encrypt(agencyId, id, userToken.accessToken),
          tokenExpiresAt: expiresAt,
          connectedBy: ctx.actor.userId,
        },
        now,
      );
    }
    await compliance.audit(ctx, 'social.account.connected', null, {
      accounts: wanted.length,
      platforms: [...new Set(wanted.map((w) => w.platform))].sort(),
    });
    const rows = await repo.listAccounts(ctx.tx, agencyId, MAX_ACCOUNTS);
    return { items: rows.map(toAccountDto) };
  });
}

/** `DELETE /v1/social/accounts/:accountId`: the account and its posts go (its tokens with it). Audited. */
export async function disconnectSocialAccount(ctx: Ctx, accountId: string): Promise<void> {
  assertCan(ctx, 'social.manage');
  await assertEnabled(ctx);
  if (!(await repo.deleteAccount(ctx.tx, ctx.tenant.agencyId, accountId))) {
    throw new AppError('SOCIAL_ACCOUNT_NOT_FOUND');
  }
  await compliance.audit(ctx, 'social.account.disconnected', { type: 'socialAccount', id: accountId });
}

// ── Posts ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The images a post publishes: the ones asked for (each a processed image of the listing), or the cover and the next
 * ones up to the maximum. `VALIDATION_FAILED` when there is none.
 */
async function imagesFor(ctx: Ctx, listing: { id: string; agencyId: string }, asked?: readonly string[]) {
  const images = (await media.listingSocialImages(ctx.tx, listing.id, listing.agencyId)).filter((i) => i.key !== null);
  if (asked) {
    const ready = new Set(images.map((i) => i.mediaId));
    const unknown = asked.filter((id) => !ready.has(id));
    if (unknown.length > 0) throw new AppError('VALIDATION_FAILED', { field: 'mediaIds', reason: 'not_ready_images' });
    return [...new Set(asked)];
  }
  const ordered = [...images.filter((i) => i.cover), ...images.filter((i) => !i.cover)];
  if (ordered.length === 0) throw new AppError('VALIDATION_FAILED', { field: 'mediaIds', reason: 'no_images' });
  return ordered.slice(0, SOCIAL_LIMITS.maxImages).map((i) => i.mediaId);
}

/** A listing a post may show: one the caller can read, live and PUBLIC (social posts are public). */
async function postableListing(ctx: Ctx, listingId: string): Promise<{ id: string; agencyId: string }> {
  const owner = await properties.assertListingReadable(ctx, listingId);
  const listing = await properties.getListing(ctx, listingId);
  if (listing.status !== 'ACTIVE' || listing.visibility !== 'PUBLIC') {
    throw new AppError('VALIDATION_FAILED', { field: 'listingId', reason: 'not_public' });
  }
  return { id: listingId, agencyId: owner.agencyId };
}

function scheduleOf(at: string | null | undefined): Date | null {
  if (!at) return null;
  const when = new Date(at);
  const now = clock.now().getTime();
  // A minute's grace for a clock behind; at most `maxScheduleDays` ahead.
  if (when.getTime() < now - 60_000 || when.getTime() > now + SOCIAL_LIMITS.maxScheduleDays * 86_400_000) {
    throw new AppError('VALIDATION_FAILED', { field: 'scheduledAt', reason: 'out_of_range' });
  }
  return when;
}

/** The typed caption joins the drafts as HUMAN for its language (replacing that language's entry). */
function withCaption(captions: repo.Captions, locale: string, caption: string | null | undefined): repo.Captions {
  if (caption === undefined) return captions;
  const others = captions.filter((c) => !(c.locale === locale && c.origin === 'HUMAN'));
  return caption ? [...others, { locale, text: caption, origin: 'HUMAN' as const }] : others;
}

async function activeAccount(ctx: Ctx, accountId: string): Promise<repo.AccountRow> {
  const account = await repo.getAccount(ctx.tx, ctx.tenant.agencyId, accountId);
  if (!account) throw new AppError('SOCIAL_ACCOUNT_NOT_FOUND');
  if (account.status !== 'ACTIVE') throw new AppError('SOCIAL_ACCOUNT_NEEDS_RECONNECT');
  return account;
}

async function requestCaptionsFor(ctx: Ctx, postId: string, locales: readonly string[]): Promise<string> {
  const requestId = newId();
  await emit(
    ctx.tx,
    socialEvents.captionsRequested({
      postId,
      agencyId: ctx.tenant.agencyId,
      requestId,
      locales: [...new Set(locales)],
    }),
  );
  return requestId;
}

/** `POST /v1/social/posts`: a DRAFT, or SCHEDULED with `scheduledAt`; AI captions requested with `captionLocales`. */
export async function createSocialPost(ctx: Ctx, input: CreateSocialPostBody): Promise<SocialPostDto> {
  assertCan(ctx, 'social.post');
  await assertEnabled(ctx);
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  const account = await activeAccount(ctx, input.accountId);
  const listing = await postableListing(ctx, input.listingId);
  const mediaIds = await imagesFor(ctx, listing, input.mediaIds);
  const scheduledAt = scheduleOf(input.scheduledAt);
  const id = newId();
  const now = clock.now();
  const requestId = input.captionLocales ? newId() : null;
  const row = await repo.insertPost(ctx.tx, {
    id,
    agencyId: ctx.tenant.agencyId,
    accountId: account.id,
    listingId: listing.id,
    status: scheduledAt ? 'SCHEDULED' : 'DRAFT',
    locale: input.locale,
    caption: input.caption ?? null,
    captions: withCaption([], input.locale, input.caption),
    captionStatus: requestId ? 'PENDING' : 'NONE',
    captionRequestId: requestId,
    mediaIds,
    scheduledAt,
    createdBy: ctx.actor.userId,
    createdAt: now,
    updatedAt: now,
  });
  if (requestId && input.captionLocales) {
    await emit(
      ctx.tx,
      socialEvents.captionsRequested({
        postId: id,
        agencyId: ctx.tenant.agencyId,
        requestId,
        locales: [...new Set(input.captionLocales)],
      }),
    );
  }
  return toPostDto(row, account.platform);
}

async function editablePost(ctx: Ctx, postId: string, version: number): Promise<repo.PostRow> {
  const post = await repo.getPost(ctx.tx, ctx.tenant.agencyId, postId, true);
  if (!post) throw new AppError('SOCIAL_POST_NOT_FOUND');
  if (!EDITABLE.has(post.status)) throw new AppError('SOCIAL_POST_NOT_EDITABLE', { status: post.status });
  if (post.version !== version) throw new AppError('VERSION_CONFLICT', { current: post.version });
  return post;
}

async function platformOf(ctx: Ctx, accountId: string): Promise<repo.SocialPlatform> {
  const account = await repo.getAccount(ctx.tx, ctx.tenant.agencyId, accountId);
  if (!account) throw new AppError('SOCIAL_ACCOUNT_NOT_FOUND');
  return account.platform;
}

/** `PATCH /v1/social/posts/:postId`: images, caption, language and schedule of a DRAFT or SCHEDULED post. */
export async function updateSocialPost(ctx: Ctx, postId: string, input: UpdateSocialPostBody): Promise<SocialPostDto> {
  assertCan(ctx, 'social.post');
  await assertEnabled(ctx);
  const post = await editablePost(ctx, postId, input.version);
  const mediaIds = input.mediaIds
    ? await imagesFor(ctx, await postableListing(ctx, post.listingId), input.mediaIds)
    : post.mediaIds;
  const scheduledAt = input.scheduledAt === undefined ? post.scheduledAt : scheduleOf(input.scheduledAt);
  if (scheduledAt) await activeAccount(ctx, post.accountId);
  const locale = input.locale ?? post.locale;
  const row = await repo.updatePost(
    ctx.tx,
    post.id,
    post.version,
    {
      mediaIds,
      locale,
      ...(input.caption === undefined ? {} : { caption: input.caption }),
      captions: withCaption(post.captions, locale, input.caption),
      scheduledAt,
      status: scheduledAt ? 'SCHEDULED' : 'DRAFT',
      errorCode: null,
      errorMessage: null,
    },
    clock.now(),
  );
  if (!row) throw new AppError('VERSION_CONFLICT');
  return toPostDto(row, await platformOf(ctx, row.accountId));
}

/** `POST /v1/social/posts/:postId/captions`: AI drafts in these languages (worker job; the post shows PENDING). */
export async function requestSocialCaptions(
  ctx: Ctx,
  postId: string,
  input: RequestSocialCaptionsBody,
): Promise<SocialPostDto> {
  assertCan(ctx, 'social.post');
  await assertEnabled(ctx);
  const post = await editablePost(ctx, postId, input.version);
  const requestId = await requestCaptionsFor(ctx, post.id, input.locales);
  const row = await repo.updatePost(
    ctx.tx,
    post.id,
    post.version,
    { captionStatus: 'PENDING', captionRequestId: requestId },
    clock.now(),
  );
  if (!row) throw new AppError('VERSION_CONFLICT');
  return toPostDto(row, await platformOf(ctx, row.accountId));
}

/** `POST /v1/social/posts/:postId/cancel`: a DRAFT or SCHEDULED post never publishes. */
export async function cancelSocialPost(ctx: Ctx, postId: string, input: { version: number }): Promise<SocialPostDto> {
  assertCan(ctx, 'social.post');
  await assertEnabled(ctx);
  const post = await editablePost(ctx, postId, input.version);
  const row = await repo.updatePost(ctx.tx, post.id, post.version, { status: 'CANCELLED' }, clock.now());
  if (!row) throw new AppError('VERSION_CONFLICT');
  return toPostDto(row, await platformOf(ctx, row.accountId));
}

export async function getSocialPost(ctx: Ctx, postId: string): Promise<SocialPostDto> {
  assertCan(ctx, 'social.read');
  await assertEnabled(ctx);
  const post = await repo.getPost(ctx.tx, ctx.tenant.agencyId, postId);
  if (!post) throw new AppError('SOCIAL_POST_NOT_FOUND');
  return toPostDto(post, await platformOf(ctx, post.accountId));
}

/** `GET /v1/social/posts`: the history, newest first, with each post's status and last error. Two statements. */
export async function listSocialPosts(ctx: Ctx, q: ListSocialPostsQuery): Promise<SocialPostPage> {
  assertCan(ctx, 'social.read');
  await assertEnabled(ctx);
  const { agencyId } = ctx.tenant;
  const rows = await repo.listPosts(ctx.tx, agencyId, {
    limit: q.limit,
    cursor: decodeCursor(q.cursor),
    ...(q.status ? { status: q.status } : {}),
  });
  const platforms = new Map(
    (await repo.listAccounts(ctx.tx, agencyId, MAX_ACCOUNTS)).map((a) => [a.id, a.platform] as const),
  );
  return toPage(
    rows,
    q.limit,
    (r) => ({ at: r.createdAt, id: r.id, atUs: r.atUs }),
    (r) => toPostDto(r, platforms.get(r.accountId) ?? 'FACEBOOK_PAGE'),
  );
}
