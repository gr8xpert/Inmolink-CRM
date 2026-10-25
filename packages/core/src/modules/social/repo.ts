import type { Tx } from '@inmolink/db';
import { socialAccounts, socialPosts } from '@inmolink/db/schema/social';
import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfterRaw, keysetOrderRaw, keysetStamp } from '../../pagination';

/**
 * social repo (PATTERNS §5): this module's tables only. Token columns are hidden from `app_user`: request queries
 * never select them; only the worker (`app_system`) reads them, to publish and refresh.
 */

export type SocialPlatform = (typeof socialAccounts.$inferSelect)['platform'];
export type SocialPostStatus = (typeof socialPosts.$inferSelect)['status'];
export type CaptionStatus = (typeof socialPosts.$inferSelect)['captionStatus'];
export type Captions = (typeof socialPosts.$inferSelect)['captions'];

const accountColumns = {
  id: socialAccounts.id,
  agencyId: socialAccounts.agencyId,
  platform: socialAccounts.platform,
  externalId: socialAccounts.externalId,
  pageId: socialAccounts.pageId,
  name: socialAccounts.name,
  tokenExpiresAt: socialAccounts.tokenExpiresAt,
  status: socialAccounts.status,
  statusReason: socialAccounts.statusReason,
  version: socialAccounts.version,
  createdAt: socialAccounts.createdAt,
  updatedAt: socialAccounts.updatedAt,
};
export type AccountRow = {
  id: string;
  agencyId: string;
  platform: SocialPlatform;
  externalId: string;
  pageId: string | null;
  name: string;
  tokenExpiresAt: Date | null;
  status: 'ACTIVE' | 'NEEDS_RECONNECT';
  statusReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

/** The agency's accounts, oldest first (at most `MAX_ACCOUNTS`: never paginated). */
/** `status_reason` of an account an admin disconnected: hidden, its permissions revoked and its row deleted by the worker. */
export const DISCONNECTED = 'DISCONNECTED';
const notDisconnected = sql`${socialAccounts.statusReason} is distinct from ${DISCONNECTED}`;

export async function listAccounts(tx: Tx, agencyId: string, limit: number): Promise<AccountRow[]> {
  return tx
    .select(accountColumns)
    .from(socialAccounts)
    .where(and(eq(socialAccounts.agencyId, agencyId), notDisconnected))
    .orderBy(asc(socialAccounts.createdAt), asc(socialAccounts.id))
    .limit(limit);
}

export async function getAccount(tx: Tx, agencyId: string, id: string): Promise<AccountRow | null> {
  const [row] = await tx
    .select(accountColumns)
    .from(socialAccounts)
    .where(and(eq(socialAccounts.agencyId, agencyId), eq(socialAccounts.id, id), notDisconnected));
  return row ?? null;
}

export async function countAccounts(tx: Tx, agencyId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(socialAccounts)
    .where(eq(socialAccounts.agencyId, agencyId));
  return row?.n ?? 0;
}

/** The ids of the agency's accounts at Meta already connected (`platform:externalId` → row id). One statement. */
export async function accountIdsByExternal(
  tx: Tx,
  agencyId: string,
  keys: readonly { platform: SocialPlatform; externalId: string }[],
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const rows = await tx
    .select({ id: socialAccounts.id, platform: socialAccounts.platform, externalId: socialAccounts.externalId })
    .from(socialAccounts)
    .where(
      and(
        eq(socialAccounts.agencyId, agencyId),
        inArray(
          socialAccounts.externalId,
          keys.map((k) => k.externalId),
        ),
      ),
    );
  return new Map(rows.map((r) => [`${r.platform}:${r.externalId}`, r.id]));
}

export interface AccountWrite {
  id: string;
  agencyId: string;
  platform: SocialPlatform;
  externalId: string;
  pageId: string | null;
  name: string;
  tokenEnc: string;
  userTokenEnc: string | null;
  tokenExpiresAt: Date | null;
  /** S13-F5: the Meta user whose login connected it. */
  metaUserId: string;
  connectedBy: string;
}

/** Inserts the account, or (connected again) replaces its tokens and makes it ACTIVE. */
export async function upsertAccount(tx: Tx, row: AccountWrite, now: Date): Promise<void> {
  await tx
    .insert(socialAccounts)
    .values({ ...row, status: 'ACTIVE', checkedAt: now, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [socialAccounts.agencyId, socialAccounts.platform, socialAccounts.externalId],
      set: {
        name: row.name,
        pageId: row.pageId,
        tokenEnc: row.tokenEnc,
        userTokenEnc: row.userTokenEnc,
        tokenExpiresAt: row.tokenExpiresAt,
        metaUserId: row.metaUserId,
        status: 'ACTIVE',
        statusReason: null,
        checkedAt: now,
        connectedBy: row.connectedBy,
        version: sql`${socialAccounts.version} + 1`,
        updatedAt: now,
      },
    });
}

/** Hides a disconnected account (the worker revokes and deletes it); false when there is none to disconnect. */
export async function markDisconnected(tx: Tx, agencyId: string, id: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(socialAccounts)
    .set({
      status: 'NEEDS_RECONNECT',
      statusReason: DISCONNECTED,
      version: sql`${socialAccounts.version} + 1`,
      updatedAt: now,
    })
    .where(and(eq(socialAccounts.agencyId, agencyId), eq(socialAccounts.id, id), notDisconnected))
    .returning({ id: socialAccounts.id });
  return rows.length > 0;
}

/** The disconnected account's row goes, unless it was connected again meanwhile (worker). */
export async function deleteDisconnected(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx
    .delete(socialAccounts)
    .where(and(eq(socialAccounts.id, id), eq(socialAccounts.statusReason, DISCONNECTED)))
    .returning({ id: socialAccounts.id });
  return rows.length > 0;
}

// ── Worker (app_system) ──────────────────────────────────────────────────────────────────────────────

export interface AccountSecrets extends AccountRow {
  tokenEnc: string;
  userTokenEnc: string | null;
  metaUserId: string | null;
}

/** An account with its encrypted tokens and its Meta user (worker only). */
export async function accountWithTokens(tx: Tx, id: string): Promise<AccountSecrets | null> {
  const [row] = await tx
    .select({
      ...accountColumns,
      tokenEnc: socialAccounts.tokenEnc,
      userTokenEnc: socialAccounts.userTokenEnc,
      metaUserId: socialAccounts.metaUserId,
    })
    .from(socialAccounts)
    .where(eq(socialAccounts.id, id));
  return row ?? null;
}

/**
 * S13-F5: every account of the Meta user, in any agency, locked (worker, `app_system`): the revoke jobs of one user's
 * accounts run one after another, so only the last one left revokes the grant. One indexed statement
 * (`social_accounts_meta_user_idx`); a user connects a handful of accounts.
 */
export async function lockMetaUserAccounts(
  tx: Tx,
  metaUserId: string,
): Promise<{ id: string; agencyId: string; status: 'ACTIVE' | 'NEEDS_RECONNECT'; statusReason: string | null }[]> {
  return tx
    .select({
      id: socialAccounts.id,
      agencyId: socialAccounts.agencyId,
      status: socialAccounts.status,
      statusReason: socialAccounts.statusReason,
    })
    .from(socialAccounts)
    .where(eq(socialAccounts.metaUserId, metaUserId))
    .for('update');
}

/** S13-F5 review: a live (not disconnected) account connected before the Meta user was stored — any agency. */
export async function hasLiveAccountWithoutMetaUser(tx: Tx): Promise<boolean> {
  const rows = await tx
    .select({ id: socialAccounts.id })
    .from(socialAccounts)
    .where(and(isNull(socialAccounts.metaUserId), notDisconnected))
    .limit(1);
  return rows.length > 0;
}

/** Live accounts without a stored Meta user that still hold a user token, the least recently tried first (worker). */
export async function accountsWithoutMetaUser(tx: Tx, limit: number): Promise<string[]> {
  const rows = await tx
    .select({ id: socialAccounts.id })
    .from(socialAccounts)
    .where(and(isNull(socialAccounts.metaUserId), isNotNull(socialAccounts.userTokenEnc), notDisconnected))
    .orderBy(asc(socialAccounts.updatedAt), asc(socialAccounts.id))
    .limit(limit);
  return rows.map((r) => r.id);
}

/** Stores the Meta user of an account that had none (never overwrites); null only marks it as tried. */
export async function setMetaUser(tx: Tx, id: string, metaUserId: string | null, now: Date): Promise<void> {
  await tx
    .update(socialAccounts)
    .set(metaUserId ? { metaUserId, updatedAt: now } : { updatedAt: now })
    .where(and(eq(socialAccounts.id, id), isNull(socialAccounts.metaUserId)));
}

/**
 * ACTIVE accounts whose user token expires before `before` and that were not checked since `checkedBefore`, soonest
 * first (worker: refresh or mark for reconnection).
 */
export async function accountsToCheck(tx: Tx, before: Date, checkedBefore: Date, limit: number): Promise<string[]> {
  const rows = await tx
    .select({ id: socialAccounts.id })
    .from(socialAccounts)
    .where(
      and(
        eq(socialAccounts.status, 'ACTIVE'),
        lte(socialAccounts.tokenExpiresAt, before),
        sql`(${socialAccounts.checkedAt} is null or ${socialAccounts.checkedAt} < ${checkedBefore.toISOString()}::timestamptz)`,
      ),
    )
    .orderBy(asc(socialAccounts.tokenExpiresAt))
    .limit(limit);
  return rows.map((r) => r.id);
}

/** New tokens after a refresh. */
export async function updateTokens(
  tx: Tx,
  id: string,
  t: { tokenEnc: string; userTokenEnc: string | null; tokenExpiresAt: Date | null },
  now: Date,
): Promise<void> {
  await tx
    .update(socialAccounts)
    .set({ ...t, checkedAt: now, updatedAt: now })
    .where(eq(socialAccounts.id, id));
}

/** NEEDS_RECONNECT, once: true only when this call changed it (the caller then announces it). */
export async function markNeedsReconnect(tx: Tx, id: string, reason: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(socialAccounts)
    .set({
      status: 'NEEDS_RECONNECT',
      statusReason: reason,
      checkedAt: now,
      version: sql`${socialAccounts.version} + 1`,
      updatedAt: now,
    })
    .where(and(eq(socialAccounts.id, id), eq(socialAccounts.status, 'ACTIVE')))
    .returning({ id: socialAccounts.id });
  return rows.length > 0;
}

// ── Posts ────────────────────────────────────────────────────────────────────────────────────────────

const postColumns = {
  atUs: keysetStamp(socialPosts.createdAt),
  id: socialPosts.id,
  agencyId: socialPosts.agencyId,
  accountId: socialPosts.accountId,
  listingId: socialPosts.listingId,
  status: socialPosts.status,
  locale: socialPosts.locale,
  caption: socialPosts.caption,
  captions: socialPosts.captions,
  captionStatus: socialPosts.captionStatus,
  captionRequestId: socialPosts.captionRequestId,
  mediaIds: socialPosts.mediaIds,
  scheduledAt: socialPosts.scheduledAt,
  claimedAt: socialPosts.claimedAt,
  publishStartedAt: socialPosts.publishStartedAt,
  publishedAt: socialPosts.publishedAt,
  externalPostId: socialPosts.externalPostId,
  attempts: socialPosts.attempts,
  errorCode: socialPosts.errorCode,
  errorMessage: socialPosts.errorMessage,
  createdBy: socialPosts.createdBy,
  version: socialPosts.version,
  createdAt: socialPosts.createdAt,
  updatedAt: socialPosts.updatedAt,
};
export type PostRow = {
  atUs: string;
  id: string;
  agencyId: string;
  accountId: string;
  listingId: string;
  status: SocialPostStatus;
  locale: string;
  caption: string | null;
  captions: Captions;
  captionStatus: CaptionStatus;
  captionRequestId: string | null;
  mediaIds: string[];
  scheduledAt: Date | null;
  claimedAt: Date | null;
  publishStartedAt: Date | null;
  publishedAt: Date | null;
  externalPostId: string | null;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdBy: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type PostInsert = typeof socialPosts.$inferInsert;

export async function insertPost(tx: Tx, row: PostInsert): Promise<PostRow> {
  const [saved] = await tx.insert(socialPosts).values(row).returning(postColumns);
  return saved as PostRow;
}

export async function getPost(tx: Tx, agencyId: string, id: string, forUpdate = false): Promise<PostRow | null> {
  const query = tx
    .select(postColumns)
    .from(socialPosts)
    .where(and(eq(socialPosts.agencyId, agencyId), eq(socialPosts.id, id)));
  const [row] = forUpdate ? await query.for('update') : await query;
  return row ?? null;
}

/** The agency's posts, newest first (keyset on the raw `created_at`). */
export async function listPosts(
  tx: Tx,
  agencyId: string,
  q: { limit: number; cursor?: KeysetCursor; status?: SocialPostStatus },
): Promise<PostRow[]> {
  return tx
    .select(postColumns)
    .from(socialPosts)
    .where(
      and(
        eq(socialPosts.agencyId, agencyId),
        q.status ? eq(socialPosts.status, q.status) : undefined,
        keysetAfterRaw(socialPosts.createdAt, socialPosts.id, q.cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrderRaw(socialPosts.createdAt, socialPosts.id, 'desc'))
    .limit(q.limit + 1);
}

/** A post's change on the version read; null when the version moved meanwhile. */
export async function updatePost(
  tx: Tx,
  id: string,
  version: number,
  patch: Partial<PostInsert>,
  now: Date,
): Promise<PostRow | null> {
  const [row] = await tx
    .update(socialPosts)
    .set({ ...patch, version: sql`${socialPosts.version} + 1`, updatedAt: now })
    .where(and(eq(socialPosts.id, id), eq(socialPosts.version, version)))
    .returning(postColumns);
  return row ?? null;
}

/**
 * The publish sweep's claim (worker): due SCHEDULED posts, at most `perAgency` of one agency, soonest first, become
 * PUBLISHING with `claimed_at` = now (`FOR UPDATE SKIP LOCKED`: concurrent sweeps take different posts).
 */
export async function claimDuePosts(
  tx: Tx,
  now: Date,
  limit: number,
  perAgency: number,
): Promise<{ id: string; agencyId: string; claimedAt: Date }[]> {
  const rows = await tx.execute<{ id: string; agency_id: string; claimed_at: Date }>(sql`
    with locked as (
      select p.id, p.agency_id, p.scheduled_at
        from ${socialPosts} p
       where p.status = 'SCHEDULED' and p.scheduled_at <= ${now.toISOString()}::timestamptz
       order by p.scheduled_at, p.id
       limit ${limit * 4}
         for update skip locked
    ), due as (
      select id, row_number() over (partition by agency_id order by scheduled_at, id) as n, scheduled_at
        from locked
    ), picked as (
      select id from due where n <= ${perAgency} order by scheduled_at, id limit ${limit}
    )
    update ${socialPosts} s
       set status = 'PUBLISHING', claimed_at = ${now.toISOString()}::timestamptz, publish_started_at = null,
           version = s.version + 1, updated_at = ${now.toISOString()}::timestamptz
      from picked
     where s.id = picked.id
    returning s.id, s.agency_id, s.claimed_at`);
  return rows.rows.map((r) => ({ id: r.id, agencyId: r.agency_id, claimedAt: new Date(r.claimed_at) }));
}

/** The publish job's lock on its post (worker). */
export async function lockPost(tx: Tx, id: string): Promise<PostRow | null> {
  const [row] = await tx.select(postColumns).from(socialPosts).where(eq(socialPosts.id, id)).for('update');
  return row ?? null;
}

/** Worker writes on a post (publishing state, outcome): no version check, the job holds the claim. */
export async function setPostState(tx: Tx, id: string, patch: Partial<PostInsert>, now: Date): Promise<void> {
  await tx
    .update(socialPosts)
    .set({ ...patch, version: sql`${socialPosts.version} + 1`, updatedAt: now })
    .where(eq(socialPosts.id, id));
}

/** The AI captions of a request, unless a newer request replaced it (worker). */
export async function saveCaptions(
  tx: Tx,
  id: string,
  requestId: string,
  patch: { captions: Captions; captionStatus: CaptionStatus; caption?: string | null },
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(socialPosts)
    .set({ ...patch, version: sql`${socialPosts.version} + 1`, updatedAt: now })
    .where(and(eq(socialPosts.id, id), eq(socialPosts.captionRequestId, requestId)))
    .returning({ id: socialPosts.id });
  return rows.length > 0;
}

/**
 * PUBLISHING posts whose claim is older than `cutoff` (their job died or never ran): one that started calling Meta
 * fails as OUTCOME_UNKNOWN (never posted twice), one that never started goes back to SCHEDULED. Worker.
 */
export async function settleStaleClaims(
  tx: Tx,
  cutoff: Date,
  now: Date,
): Promise<{ unknown: number; requeued: number }> {
  const c = cutoff.toISOString();
  const n = now.toISOString();
  const unknown = await tx.execute(sql`
    update ${socialPosts} set status = 'FAILED', error_code = 'OUTCOME_UNKNOWN', error_message = null,
           version = version + 1, updated_at = ${n}::timestamptz
     where status = 'PUBLISHING' and claimed_at < ${c}::timestamptz and publish_started_at is not null`);
  const requeued = await tx.execute(sql`
    update ${socialPosts} set status = 'SCHEDULED', claimed_at = null, version = version + 1,
           updated_at = ${n}::timestamptz
     where status = 'PUBLISHING' and claimed_at < ${c}::timestamptz and publish_started_at is null`);
  return { unknown: unknown.rowCount ?? 0, requeued: requeued.rowCount ?? 0 };
}
