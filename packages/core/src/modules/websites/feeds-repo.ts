/**
 * Site XML feed queries (S7-07). `app_user` (dashboard: the agency's own feed), `app_public` (feed-api: a token's
 * lookup — revoked feeds are invisible, `created_by` and `last_error` not granted) and `app_system` (the generator's
 * runs and the refresh sweep). Queries only `website_feeds`.
 */
import type { Tx } from '@inmolink/db';
import { websiteFeeds } from '@inmolink/db/schema/websites';
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';

export interface FeedRow {
  siteId: string;
  agencyId: string;
  tokenHint: string;
  tokenCreatedAt: Date;
  revokedAt: Date | null;
  generatedAt: Date | null;
  itemCount: number | null;
  kyeroCount: number | null;
  lastError: string | null;
}

const feedColumns = {
  siteId: websiteFeeds.siteId,
  agencyId: websiteFeeds.agencyId,
  tokenHint: websiteFeeds.tokenHint,
  tokenCreatedAt: websiteFeeds.tokenCreatedAt,
  revokedAt: websiteFeeds.revokedAt,
  generatedAt: websiteFeeds.generatedAt,
  itemCount: websiteFeeds.itemCount,
  kyeroCount: websiteFeeds.kyeroCount,
  lastError: websiteFeeds.lastError,
};

export async function getFeed(tx: Tx, agencyId: string, siteId: string): Promise<FeedRow | null> {
  const [row] = await tx
    .select(feedColumns)
    .from(websiteFeeds)
    .where(and(eq(websiteFeeds.agencyId, agencyId), eq(websiteFeeds.siteId, siteId)))
    .limit(1);
  return row ?? null;
}

/** What a token rotation checks (S7-07 review): the live token's hash, version and idempotency key; locked. */
export async function feedForRotation(
  tx: Tx,
  agencyId: string,
  siteId: string,
): Promise<{
  tokenHash: string;
  idempotencyHash: string | null;
  tokenCreatedAt: Date;
  version: number;
  revokedAt: Date | null;
} | null> {
  const [row] = await tx
    .select({
      tokenHash: websiteFeeds.tokenHash,
      idempotencyHash: websiteFeeds.idempotencyHash,
      tokenCreatedAt: websiteFeeds.tokenCreatedAt,
      version: websiteFeeds.version,
      revokedAt: websiteFeeds.revokedAt,
    })
    .from(websiteFeeds)
    .where(and(eq(websiteFeeds.agencyId, agencyId), eq(websiteFeeds.siteId, siteId)))
    .for('update')
    .limit(1);
  return row ?? null;
}

/** A new token for the site's feed (the first, or a rotation: the old hash is gone, a revoked feed is live again). */
export async function setFeedToken(
  tx: Tx,
  f: {
    siteId: string;
    agencyId: string;
    tokenHash: string;
    tokenHint: string;
    idempotencyHash: string | null;
    createdBy: string;
    now: Date;
  },
): Promise<FeedRow> {
  const [row] = await tx
    .insert(websiteFeeds)
    .values({
      siteId: f.siteId,
      agencyId: f.agencyId,
      tokenHash: f.tokenHash,
      tokenHint: f.tokenHint,
      tokenCreatedAt: f.now,
      idempotencyHash: f.idempotencyHash,
      createdBy: f.createdBy,
      createdAt: f.now,
      updatedAt: f.now,
    })
    .onConflictDoUpdate({
      target: websiteFeeds.siteId,
      set: {
        tokenHash: f.tokenHash,
        tokenHint: f.tokenHint,
        tokenCreatedAt: f.now,
        idempotencyHash: f.idempotencyHash,
        revokedAt: null,
        createdBy: f.createdBy,
        version: sql`${websiteFeeds.version} + 1`,
        updatedAt: f.now,
      },
      // Never another agency's row (RLS hides it anyway; the conflict target is the site id).
      setWhere: eq(websiteFeeds.agencyId, f.agencyId),
    })
    .returning(feedColumns);
  if (!row) throw new Error('website_feeds: token not set');
  return row;
}

/** Revokes the site's feed and forgets its run; null when there is none or it is revoked already. */
export async function revokeFeed(tx: Tx, agencyId: string, siteId: string, now: Date): Promise<FeedRow | null> {
  const [row] = await tx
    .update(websiteFeeds)
    // The run's files are deleted by the worker (`websiteApi.deleteSiteFeedFiles`); nothing points at them any more.
    .set({
      revokedAt: now,
      runId: null,
      kyeroSha256: null,
      genericSha256: null,
      version: sql`${websiteFeeds.version} + 1`,
      updatedAt: now,
    })
    .where(and(eq(websiteFeeds.agencyId, agencyId), eq(websiteFeeds.siteId, siteId), isNull(websiteFeeds.revokedAt)))
    .returning(feedColumns);
  return row ?? null;
}

export interface FeedServeRow {
  siteId: string;
  agencyId: string;
  tokenHash: string;
  runId: string | null;
  kyeroSha256: string | null;
  genericSha256: string | null;
}

/** feed-api (`app_public`): the live feed with this token hash (unique index). One statement. */
export async function feedByTokenHash(tx: Tx, tokenHash: string): Promise<FeedServeRow | null> {
  const [row] = await tx
    .select({
      siteId: websiteFeeds.siteId,
      agencyId: websiteFeeds.agencyId,
      tokenHash: websiteFeeds.tokenHash,
      runId: websiteFeeds.runId,
      kyeroSha256: websiteFeeds.kyeroSha256,
      genericSha256: websiteFeeds.genericSha256,
    })
    .from(websiteFeeds)
    .where(and(eq(websiteFeeds.tokenHash, tokenHash), isNull(websiteFeeds.revokedAt)))
    .limit(1);
  return row ?? null;
}

/** Worker: the site's live feed (agency, current run), or null when it has none or it is revoked. */
export async function liveFeed(tx: Tx, siteId: string): Promise<{ agencyId: string; runId: string | null } | null> {
  const [row] = await tx
    .select({ agencyId: websiteFeeds.agencyId, runId: websiteFeeds.runId })
    .from(websiteFeeds)
    .where(and(eq(websiteFeeds.siteId, siteId), isNull(websiteFeeds.revokedAt)))
    .limit(1);
  return row ?? null;
}

export interface FeedRun {
  siteId: string;
  runId: string;
  /** When the run started reading: a run that started before the recorded one never replaces it. */
  startedAt: Date;
  generatedAt: Date;
  itemCount: number;
  kyeroCount: number;
  kyeroSha256: string;
  genericSha256: string;
}

/**
 * Worker: records a finished run as the served one, unless the feed was revoked or a run that started later was
 * recorded first. Returns `{ recorded, previousRunId }` (the run whose files are no longer served).
 */
export async function recordFeedRun(
  tx: Tx,
  run: FeedRun,
): Promise<{ recorded: boolean; previousRunId: string | null }> {
  const res = await tx.execute<{ previous: string | null }>(sql`
    with old as (
      select site_id, run_id from ${websiteFeeds}
       where site_id = ${run.siteId} and revoked_at is null
         and (generated_at is null or generated_at <= ${run.startedAt})
       for update)
    update ${websiteFeeds} f
       set run_id = ${run.runId}, generated_at = ${run.startedAt}, item_count = ${run.itemCount},
           kyero_count = ${run.kyeroCount}, kyero_sha256 = ${run.kyeroSha256},
           generic_sha256 = ${run.genericSha256}, last_error = null, failed_at = null, updated_at = ${run.generatedAt}
      from old where f.site_id = old.site_id
    returning old.run_id as previous`);
  const row = res.rows[0];
  return row ? { recorded: true, previousRunId: row.previous } : { recorded: false, previousRunId: null };
}

/** Worker: why the last run failed (an error code). */
export async function recordFeedFailure(tx: Tx, siteId: string, code: string, now: Date): Promise<void> {
  await tx
    .update(websiteFeeds)
    .set({ lastError: code.slice(0, 64), failedAt: now, updatedAt: now })
    .where(eq(websiteFeeds.siteId, siteId));
}

/** Worker: the agency's live feeds (at most one per site, ≤ 20 sites). */
export async function agencyFeedSiteIds(tx: Tx, agencyId: string): Promise<string[]> {
  const rows = await tx
    .select({ siteId: websiteFeeds.siteId })
    .from(websiteFeeds)
    .where(and(eq(websiteFeeds.agencyId, agencyId), isNull(websiteFeeds.revokedAt)));
  return rows.map((r) => r.siteId);
}

/**
 * Worker (refresh sweep): live feeds generated before `before` (the stalest first, `website_feeds_refresh_idx`), then
 * those never generated (a new token queues its first run at once; these are runs that failed or were lost).
 */
export async function dueFeeds(tx: Tx, before: Date, limit: number): Promise<{ siteId: string; agencyId: string }[]> {
  return tx
    .select({ siteId: websiteFeeds.siteId, agencyId: websiteFeeds.agencyId })
    .from(websiteFeeds)
    .where(
      and(isNull(websiteFeeds.revokedAt), or(isNull(websiteFeeds.generatedAt), lt(websiteFeeds.generatedAt, before))),
    )
    .orderBy(asc(websiteFeeds.generatedAt))
    .limit(limit);
}
