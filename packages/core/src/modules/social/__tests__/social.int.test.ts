import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CreateListingBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { configureAi, createAiGateway, filePromptSource } from '@inmolink/platform/ai';
import { FakeProvider, memoryAiCache, memoryAiStore } from '@inmolink/platform/ai/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { isAppError } from '@inmolink/platform/errors';
import { invalidateFlags, setFlag, setFlagOverride } from '@inmolink/platform/flags';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { closeRateLimit, configureRateLimit } from '@inmolink/platform/rate-limit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder, setAiFeatures } from '../../../testing/factories';
import { plainText, textKey } from '../../../white-label';
import { writeAiRemovals } from '../../../white-label-store';
import * as billing from '../../billing';
import * as media from '../../media';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as social from '../index';
import { EXPIRED_TOKEN, type FakeGraph, startFakeGraph } from './fake-graph';

/**
 * Social posting end to end (S12-07) against a fake Meta Graph API (the real Meta app waits on H3): connecting accounts
 * (signed state, encrypted tokens), a scheduled post published once at its time — whatever the sweeps, redeliveries
 * and retries — a token Meta refuses marking the account for reconnection and notifying the agency's admins, and AI
 * captions on a fake provider (fact-checked and white-labelled).
 */

const RUN = newId().slice(-8);
const MEDIA_BASE = 'https://media.example';
const PROMPTS_DIR = fileURLToPath(new URL('../../../../prompts', import.meta.url));
const log = createLogger({ service: 'social-int', level: 'silent' });

let graph: FakeGraph;
let a: Founder;
let place: { locationId: string; propertyTypeId: string };

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const run =
  (m: Founder) =>
  <T>(fn: (ctx: Ctx) => Promise<T>) =>
    as(m, fn);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('social.int.test', fn);

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

async function enable(m: Founder, on: boolean) {
  await system(async (tx) => {
    await setFlag(tx, social.SOCIAL_FLAG, { enabled: false });
    await setFlagOverride(tx, social.SOCIAL_FLAG, m.agencyId, on ? true : null);
  });
  invalidateFlags();
}

/** A PUBLIC, ACTIVE listing of `m` with `images` processed images (the og variant ready). */
async function listing(
  m: Founder,
  images = 2,
  shareScope?: 'ALL' | 'PREFERRED',
): Promise<{ id: string; mediaIds: string[] }> {
  const id = await as(m, async (ctx) => {
    const created = await properties.createListing(
      ctx,
      CreateListingBody.parse({ ...place, priceCents: 45_000_000, energyRating: 'B', bedrooms: 3, builtM2: 140 }),
    );
    const live = await properties.updateListing(
      ctx,
      created.id,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility: 'PUBLIC',
        ...(shareScope ? { shareScope } : {}),
        version: created.version,
      }),
    );
    return live.id;
  });
  const mediaIds: string[] = [];
  await system(async (tx) => {
    for (let i = 0; i < images; i += 1) {
      const sha = `${RUN}${id.slice(-6)}${i}`.padEnd(64, 'c');
      const mediaId = newId();
      mediaIds.push(mediaId);
      await tx.execute(sql`insert into media_objects (sha256, size_bytes, content_type, pipeline, variants_ready, width, height)
        values (${sha}, 10, 'image/jpeg', 1, 31, 1600, 1200) on conflict do nothing`);
      await tx.execute(sql`insert into property_media (id, property_id, agency_id, sha256, kind, position, is_cover)
        values (${mediaId}, ${id}, ${m.agencyId}, ${sha}, 'IMAGE', ${i}, ${i === 0})`);
    }
    await search.rebuildReadModels(tx, 'LISTING', [id]);
  });
  return { id, mediaIds };
}

/** Connects the fake user's Pages (and their Instagram accounts) for `m`. */
async function connect(m: Founder) {
  const { url } = await as(m, (ctx) => social.startSocialConnect(ctx));
  const state = new URL(url).searchParams.get('state') as string;
  return social.completeSocialConnect(run(m), { code: `code-${newId()}`, state });
}

async function latestEvent(type: string, key: string, value: string) {
  return system(async (tx) => {
    const r = await tx.execute<{ id: string; payload: Record<string, unknown>; created_at: Date }>(
      sql`select id, payload, created_at from outbox_events where type = ${type} and payload->>${key} = ${value}
           order by id desc limit 1`,
    );
    return r.rows[0];
  });
}

async function countEvents(type: string, key: string, value: string): Promise<number> {
  return system(async (tx) => {
    const r = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from outbox_events where type = ${type} and payload->>${key} = ${value}`,
    );
    return r.rows[0]?.n ?? 0;
  });
}

const postRow = (id: string) =>
  system(async (tx) => {
    const r = await tx.execute<{
      status: string;
      external_post_id: string | null;
      error_code: string | null;
      scheduled_at: Date;
    }>(sql`select status, external_post_id, error_code, scheduled_at from social_posts where id = ${id}::uuid`);
    return r.rows[0];
  });

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  media.configureMedia({ urlKey: `social-test-key-${RUN}-0123456789abcdef` });
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
  // S12-07 review: the model pass's cached removals are read from the cache
  await configureCache({ prefix: `t:social:${RUN}`, commandTimeoutMs: 2_000 });
  graph = await startFakeGraph();
  social.configureSocial({
    keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }),
    stateKey: 'test-hmac-key-0123456789abcdef0123456789',
    meta: graph.app,
    mediaBaseUrl: MEDIA_BASE,
  });
  // S13-F5: rows without a Meta user left by an earlier run (other keys) would block every revoke.
  await system((tx) => tx.execute(sql`delete from social_accounts where meta_user_id is null`));
  a = await createFounder();
  await setAgencyStatus(a.agencyId, 'VERIFIED');
  place = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const locationId = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `so-${RUN}`,
      translations: name('Socialand'),
    });
    const groupId = await taxonomy.createPropertyTypeGroup(tx, {
      key: `so-g-${RUN}`,
      sort: 0,
      translations: name('G'),
    });
    const propertyTypeId = await taxonomy.createPropertyType(tx, {
      groupId,
      key: `so-t-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { locationId, propertyTypeId };
  });
  await enable(a, true);
  // S13-F17: AI captions only once the agency's admin switched them on.
  await setAiFeatures(a, ['SOCIAL_CAPTIONS']);
}, 180_000);

beforeEach(() => {
  graph.calls.length = 0;
  graph.pages = [
    {
      id: `9${RUN.replace(/\D/g, '').padEnd(6, '1').slice(0, 6)}1`,
      name: `Costa Homes ${RUN}`,
      access_token: 'page-token-1',
      instagram_business_account: { id: `8${RUN.replace(/\D/g, '').padEnd(6, '1').slice(0, 6)}2`, username: 'costa' },
    },
  ];
});

afterAll(async () => {
  configureAi(undefined);
  await graph?.close();
  await closeRateLimit();
  await closeCache();
  await closeDb();
});

describe('social accounts (S12-07)', () => {
  it('[S12-07] connecting stores the Pages and Instagram accounts with encrypted, hidden tokens; a forged state fails', async () => {
    const res = await connect(a);
    expect(res.items.map((i) => i.platform).sort()).toEqual(['FACEBOOK_PAGE', 'INSTAGRAM_BUSINESS']);
    expect(res.items.every((i) => i.status === 'ACTIVE')).toBe(true);
    // Connected again: the same rows, updated.
    expect((await connect(a)).items).toHaveLength(2);
    // The tokens are encrypted at rest and hidden from the request role.
    const stored = await system(
      async (tx) =>
        (
          await tx.execute<{ token_enc: string }>(
            sql`select token_enc from social_accounts where agency_id = ${a.agencyId}`,
          )
        ).rows,
    );
    for (const r of stored) expect(r.token_enc).not.toContain('page-token');
    await expect(
      as(a, (ctx) => ctx.tx.execute(sql`select token_enc from social_accounts where agency_id = ${a.agencyId}`)),
    ).rejects.toThrow();
    // A state that is not this member's, or tampered with, connects nothing.
    const other = await createFounder();
    await setAgencyStatus(other.agencyId, 'VERIFIED');
    await enable(other, true);
    const { url } = await as(a, (ctx) => social.startSocialConnect(ctx));
    const state = new URL(url).searchParams.get('state') as string;
    expect(await refusal(social.completeSocialConnect(run(other), { code: 'x', state }))).toBe('SOCIAL_CONNECT_FAILED');
    // S12-07 review: a state works once — the callback replayed connects nothing.
    const once = new URL((await as(a, (ctx) => social.startSocialConnect(ctx))).url).searchParams.get(
      'state',
    ) as string;
    await social.completeSocialConnect(run(a), { code: 'first', state: once });
    expect(await refusal(social.completeSocialConnect(run(a), { code: 'again', state: once }))).toBe(
      'SOCIAL_CONNECT_FAILED',
    );
    expect(await refusal(social.completeSocialConnect(run(a), { code: 'x', state: `${state}x` }))).toBe(
      'SOCIAL_CONNECT_FAILED',
    );
    // Off for the agency: nothing.
    await enable(other, false);
    expect(await refusal(as(other, (ctx) => social.listSocialAccounts(ctx)))).toBe('SOCIAL_NOT_ENABLED');
  });
});

describe('scheduled posts (S12-07)', () => {
  it('[S12-07] a scheduled post publishes once at the scheduled time, whatever the sweeps, redeliveries and retries', async () => {
    const accounts = (await connect(a)).items;
    const page = accounts.find((i) => i.platform === 'FACEBOOK_PAGE') as (typeof accounts)[number];
    const l = await listing(a, 2);
    const at = new Date(Date.now() + 10 * 60_000);
    const post = await as(a, (ctx) =>
      social.createSocialPost(ctx, {
        accountId: page.id,
        listingId: l.id,
        locale: 'en',
        caption: 'Sea views in Socialand',
        scheduledAt: at.toISOString(),
      }),
    );
    expect(post).toMatchObject({ status: 'SCHEDULED', mediaIds: l.mediaIds });

    // Not due yet: nothing is claimed.
    await social.sweepDuePosts({ now: new Date(at.getTime() - 60_000) });
    expect((await postRow(post.id))?.status).toBe('SCHEDULED');
    // Due: claimed once, one event.
    await social.sweepDuePosts({ now: new Date(at.getTime() + 1_000) });
    await social.sweepDuePosts({ now: new Date(at.getTime() + 2_000) });
    expect(await countEvents('social.post.due', 'postId', post.id)).toBe(1);
    const due = await latestEvent('social.post.due', 'postId', post.id);
    const job = { postId: post.id, agencyId: a.agencyId, claimedAtMs: Number(due?.payload.claimedAtMs) };
    // The job runs twice at once and once more later (a redelivered event): one post at Meta.
    const outcomes = await Promise.all([social.publishPost(job), social.publishPost(job)]);
    outcomes.push(await social.publishPost(job));
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['PUBLISHED', 'SKIPPED', 'SKIPPED']);
    expect(graph.publishes()).toHaveLength(1);
    const feed = graph.publishes()[0];
    expect(feed?.fields.message).toBe('Sea views in Socialand');
    expect(Object.values(feed?.fields ?? {}).join(' ')).not.toContain('page-token-1x');
    const published = await postRow(post.id);
    expect(published).toMatchObject({ status: 'PUBLISHED', error_code: null });
    expect(published?.external_post_id).toMatch(/_\d+$/);
    // The images Meta fetched: the og variants under the media CDN, in order.
    const photos = graph.calls.filter((c) => c.path.endsWith('/photos'));
    expect(photos.map((c) => c.fields.url?.startsWith(`${MEDIA_BASE}/`))).toEqual([true, true]);
  });

  it('[S12-07] a job that died while calling Meta never posts again; a rate limit retries later and then publishes', async () => {
    const accounts = (await connect(a)).items;
    const ig = accounts.find((i) => i.platform === 'INSTAGRAM_BUSINESS') as (typeof accounts)[number];
    const l = await listing(a, 3);
    const schedule = async () => {
      const at = new Date(Date.now() + 60_000);
      const post = await as(a, (ctx) =>
        social.createSocialPost(ctx, {
          accountId: ig.id,
          listingId: l.id,
          locale: 'en',
          caption: 'Carousel',
          scheduledAt: at.toISOString(),
        }),
      );
      await social.sweepDuePosts({ now: new Date(at.getTime() + 1_000) });
      const due = await latestEvent('social.post.due', 'postId', post.id);
      return { post, job: { postId: post.id, agencyId: a.agencyId, claimedAtMs: Number(due?.payload.claimedAtMs) } };
    };
    // The previous attempt marked the call as started and died: the outcome is unknown, Meta is not called again.
    const crashed = await schedule();
    await system((tx) =>
      tx.execute(
        sql`update social_posts set publish_started_at = now() - interval '11 minutes' where id = ${crashed.post.id}`,
      ),
    );
    expect((await social.publishPost(crashed.job)).outcome).toBe('OUTCOME_UNKNOWN');
    expect(graph.calls.filter((c) => c.method === 'POST' && !c.path.startsWith('/oauth/'))).toHaveLength(0);
    expect(graph.publishes()).toHaveLength(0);
    expect((await postRow(crashed.post.id))?.error_code).toBe('OUTCOME_UNKNOWN');
    // A claim whose job never ran (or died) is settled by a later sweep: unknown if it had started, due again if not.
    const stale = await schedule();
    const started = await schedule();
    await system((tx) =>
      tx.execute(sql`update social_posts set claimed_at = now() - interval '11 minutes',
                       publish_started_at = case when id = ${started.post.id}::uuid then now() - interval '11 minutes' end
                      where id in (${stale.post.id}::uuid, ${started.post.id}::uuid)`),
    );
    await social.sweepDuePosts({ now: new Date(Date.now() + 61_000) });
    expect((await postRow(started.post.id))?.error_code).toBe('OUTCOME_UNKNOWN');
    expect(await countEvents('social.post.due', 'postId', stale.post.id)).toBe(2);
    expect(graph.publishes()).toHaveLength(0);

    // Rate-limited before anything was posted: back to SCHEDULED a little later, then published once.
    graph.calls.length = 0;
    graph.failWith((c) => c.fields.is_carousel_item === 'true', {
      status: 400,
      body: { error: { code: 613, message: 'slow' } },
    });
    const limited = await schedule();
    expect((await social.publishPost(limited.job)).outcome).toBe('RETRY_SCHEDULED');
    const row = await postRow(limited.post.id);
    expect(row).toMatchObject({ status: 'SCHEDULED', error_code: 'RATE_LIMITED' });
    await social.sweepDuePosts({ now: new Date(new Date(row?.scheduled_at as Date).getTime() + 1_000) });
    const again = await latestEvent('social.post.due', 'postId', limited.post.id);
    expect(
      (await social.publishPost({ ...limited.job, claimedAtMs: Number(again?.payload.claimedAtMs) })).outcome,
    ).toBe('PUBLISHED');
    expect(graph.publishes()).toHaveLength(1);
    expect(graph.calls.find((c) => c.fields.media_type === 'CAROUSEL')?.fields.children?.split(',')).toHaveLength(3);
  });

  it('[S12-07] an expired token marks the account as needing reconnection and notifies the agency', async () => {
    const accounts = (await connect(a)).items;
    const page = accounts.find((i) => i.platform === 'FACEBOOK_PAGE') as (typeof accounts)[number];
    const l = await listing(a, 1);
    const at = new Date(Date.now() + 60_000);
    const post = await as(a, (ctx) =>
      social.createSocialPost(ctx, {
        accountId: page.id,
        listingId: l.id,
        locale: 'en',
        caption: 'Hello',
        scheduledAt: at.toISOString(),
      }),
    );
    await social.sweepDuePosts({ now: new Date(at.getTime() + 1_000) });
    const due = await latestEvent('social.post.due', 'postId', post.id);
    graph.failWith((c) => c.path.endsWith('/photos'), EXPIRED_TOKEN);
    const res = await social.publishPost({
      postId: post.id,
      agencyId: a.agencyId,
      claimedAtMs: Number(due?.payload.claimedAtMs),
    });
    expect(res.outcome).toBe('ACCOUNT_NEEDS_RECONNECT');
    expect((await postRow(post.id))?.error_code).toBe('ACCOUNT_NEEDS_RECONNECT');
    const listed = await as(a, (ctx) => social.listSocialAccounts(ctx));
    expect(listed.items.find((i) => i.id === page.id)).toMatchObject({
      status: 'NEEDS_RECONNECT',
      statusReason: 'TOKEN_EXPIRED',
    });
    // Announced once; the admins (the founder) get a SOCIAL_ACCOUNT_RECONNECT notification, once.
    expect(await countEvents('social.account.needsReconnect', 'accountId', page.id)).toBe(1);
    const event = await latestEvent('social.account.needsReconnect', 'accountId', page.id);
    const p = {
      eventId: event?.id as string,
      agencyId: a.agencyId,
      accountId: page.id,
      occurredAt: new Date(event?.created_at as Date).toISOString(),
    };
    expect(await social.notifyReconnect(p)).toEqual({ notified: 1 });
    await social.notifyReconnect(p);
    const notes = await system(
      async (tx) =>
        (
          await tx.execute<{ type: string; link: string | null }>(
            sql`select type, link from notifications where agency_id = ${a.agencyId} and user_id = ${a.userId}
               and type = 'SOCIAL_ACCOUNT_RECONNECT'`,
          )
        ).rows,
    );
    expect(notes).toEqual([{ type: 'SOCIAL_ACCOUNT_RECONNECT', link: '/social' }]);
    // New posts to it are refused until it is connected again — which makes it ACTIVE.
    expect(
      await refusal(
        as(a, (ctx) => social.createSocialPost(ctx, { accountId: page.id, listingId: l.id, locale: 'en' })),
      ),
    ).toBe('SOCIAL_ACCOUNT_NEEDS_RECONNECT');
    expect((await connect(a)).items.find((i) => i.id === page.id)?.status).toBe('ACTIVE');

    // The token check: an expired user token Meta refuses to refresh → reconnect (announced once).
    await system((tx) =>
      tx.execute(sql`update social_accounts set token_expires_at = now() - interval '1 hour', checked_at = null
                      where id = ${page.id}`),
    );
    graph.failWith((c) => Boolean(c.fields.fb_exchange_token), EXPIRED_TOKEN);
    const checked = await social.checkAccounts();
    expect(checked.reconnect).toBeGreaterThanOrEqual(1);
    expect(await countEvents('social.account.needsReconnect', 'accountId', page.id)).toBe(2);
  });
});

describe('AI captions (S12-07)', () => {
  it('[S12-07] captions per language: invented figures are dropped, contacts removed, the caption filled in', async () => {
    const provider = new FakeProvider(() =>
      JSON.stringify({
        captions: [
          { locale: 'en', text: 'A 3-bedroom villa, 140 m². Mail sales@owner.example!' },
          { locale: 'es', text: 'Villa de 5 dormitorios' }, // 5 is not a fact
        ],
      }),
    );
    configureAi(
      createAiGateway({
        provider,
        models: { FAST: 'fast-model', SMART: 'smart-model' },
        pricing: { 'fast-model': { input: 1, output: 5 }, 'smart-model': { input: 5, output: 25 } },
        batchDiscountBp: 5_000,
        prompts: filePromptSource(PROMPTS_DIR),
        cache: memoryAiCache(),
        cacheTtlSeconds: 3_600,
        store: memoryAiStore(),
        budgetFor: () => ({ softMicroUsd: 1e12, hardMicroUsd: 2e12 }),
        timeoutMs: 5_000,
        breaker: { failures: 1_000, openMs: 1_000 },
        logger: log,
      }),
    );
    const accounts = (await connect(a)).items;
    const l = await listing(a, 1);
    const post = await as(a, (ctx) =>
      social.createSocialPost(ctx, {
        accountId: (accounts[0] as (typeof accounts)[number]).id,
        listingId: l.id,
        locale: 'en',
        captionLocales: ['en', 'es'],
      }),
    );
    expect(post).toMatchObject({ captionStatus: 'PENDING', caption: null });
    const req = await latestEvent('social.captions.requested', 'postId', post.id);
    const res = await social.generateCaptions({
      postId: post.id,
      agencyId: a.agencyId,
      requestId: req?.payload.requestId as string,
      locales: ['en', 'es'],
    });
    expect(res).toEqual({ captions: 1, status: 'READY' });
    const after = await as(a, (ctx) => social.getSocialPost(ctx, post.id));
    expect(after.captionStatus).toBe('READY');
    expect(after.captions).toHaveLength(1);
    expect(after.caption).toContain('3-bedroom villa');
    expect(after.caption).not.toContain('owner.example');
    // The model got the facts, and the description only inside an untrusted block.
    expect(provider.calls[0]?.user).toContain('"bedrooms":3');
    // A stale request writes nothing.
    expect(
      (await social.generateCaptions({ postId: post.id, agencyId: a.agencyId, requestId: newId(), locales: ['en'] }))
        .status,
    ).toBe('STALE');
  });

  it('[S13-F17] social captions off: requests refused (AI_NOT_ENABLED), a queued job makes zero provider calls; on: calls happen', async () => {
    const provider = new FakeProvider(() =>
      JSON.stringify({ captions: [{ locale: 'en', text: 'A 3-bedroom villa.' }] }),
    );
    configureAi(
      createAiGateway({
        provider,
        models: { FAST: 'fast-model', SMART: 'smart-model' },
        pricing: { 'fast-model': { input: 1, output: 5 }, 'smart-model': { input: 5, output: 25 } },
        batchDiscountBp: 5_000,
        prompts: filePromptSource(PROMPTS_DIR),
        cache: memoryAiCache(),
        cacheTtlSeconds: 3_600,
        store: memoryAiStore(),
        budgetFor: () => ({ softMicroUsd: 1e12, hardMicroUsd: 2e12 }),
        timeoutMs: 5_000,
        breaker: { failures: 1_000, openMs: 1_000 },
        logger: log,
      }),
    );
    const accounts = (await connect(a)).items;
    const accountId = (accounts[0] as (typeof accounts)[number]).id;
    const l = await listing(a, 1);
    // Requested while on, run after the switch off.
    const queued = await as(a, (ctx) =>
      social.createSocialPost(ctx, { accountId, listingId: l.id, locale: 'en', captionLocales: ['en'] }),
    );
    const req = await latestEvent('social.captions.requested', 'postId', queued.id);
    // every other AI feature on, captions off
    await setAiFeatures(a, ['WEBSITE_SEARCH', 'WHITE_LABEL', 'LISTING_STUDIO', 'TRANSLATION_DRAFTS']);
    await setAiFeatures(a, ['SOCIAL_CAPTIONS'], false);
    try {
      const refused = await as(a, (ctx) =>
        social.createSocialPost(ctx, { accountId, listingId: l.id, locale: 'en', captionLocales: ['en'] }),
      ).catch((err: { code?: string }) => err.code);
      expect(refused).toBe('AI_NOT_ENABLED');
      const typed = await as(a, (ctx) =>
        social.createSocialPost(ctx, { accountId, listingId: l.id, locale: 'en', caption: 'Typed by hand' }),
      );
      expect(typed).toMatchObject({ caption: 'Typed by hand', captionStatus: 'NONE' });
      const again = await as(a, (ctx) =>
        social.requestSocialCaptions(ctx, typed.id, { version: typed.version, locales: ['en'] }),
      ).catch((err: { code?: string }) => err.code);
      expect(again).toBe('AI_NOT_ENABLED');
      const run = await social.generateCaptions({
        postId: queued.id,
        agencyId: a.agencyId,
        requestId: req?.payload.requestId as string,
        locales: ['en'],
      });
      expect(run).toEqual({ captions: 0, status: 'FAILED' });
      expect(provider.calls).toHaveLength(0);
    } finally {
      await setAiFeatures(a, ['SOCIAL_CAPTIONS']);
    }
    const on = await as(a, async (ctx) => {
      const post = await social.getSocialPost(ctx, queued.id);
      return social.requestSocialCaptions(ctx, post.id, { version: post.version, locales: ['en'] });
    });
    const onReq = await latestEvent('social.captions.requested', 'postId', on.id);
    const res = await social.generateCaptions({
      postId: on.id,
      agencyId: a.agencyId,
      requestId: onReq?.payload.requestId as string,
      locales: ['en'],
    });
    expect(res.status).toBe('READY');
    expect(provider.calls).toHaveLength(1);
  });
});

describe('S12-07 review', () => {
  it('[S12-07] another agency’s listing publishes only while it is still shared with the posting agency', async () => {
    const b = await createFounder();
    await setAgencyStatus(b.agencyId, 'VERIFIED');
    const accounts = (await connect(a)).items;
    const page = accounts.find((i) => i.platform === 'FACEBOOK_PAGE') as (typeof accounts)[number];
    const l = await listing(b, 1, 'ALL');
    const schedule = async () => {
      const at = new Date(Date.now() + 60_000);
      const post = await as(a, (ctx) =>
        social.createSocialPost(ctx, {
          accountId: page.id,
          listingId: l.id,
          locale: 'en',
          caption: 'Shared villa',
          scheduledAt: at.toISOString(),
        }),
      );
      await social.sweepDuePosts({ now: new Date(at.getTime() + 1_000) });
      const due = await latestEvent('social.post.due', 'postId', post.id);
      return { postId: post.id, agencyId: a.agencyId, claimedAtMs: Number(due?.payload.claimedAtMs) };
    };
    const shared = await schedule();
    const narrowed = await schedule();
    // Shared with everyone: it publishes.
    expect((await social.publishPost(shared)).outcome).toBe('PUBLISHED');
    // The owner narrows it to its preferred agencies (a is not one): the next one does not.
    await as(b, async (ctx) =>
      properties.updateListing(
        ctx,
        l.id,
        UpdateListingBody.parse({ shareScope: 'PREFERRED', version: (await properties.getListing(ctx, l.id)).version }),
      ),
    );
    await system((tx) => search.rebuildReadModels(tx, 'LISTING', [l.id]));
    graph.calls.length = 0;
    expect((await social.publishPost(narrowed)).outcome).toBe('FAILED');
    expect((await postRow(narrowed.postId))?.error_code).toBe('LISTING_UNAVAILABLE');
    expect(graph.publishes()).toHaveLength(0);
  });

  it('[S12-07] review: a cached model removal takes an indirect mention out of the captions input and the published text', async () => {
    const INDIRECT = 'For a viewing ask for Marisol at our Nerja office.';
    const DESCRIPTION = `Villa with 4 bedrooms and a pool. ${INDIRECT} Sea views from every room.`;
    const b = await createFounder();
    await setAgencyStatus(b.agencyId, 'VERIFIED');
    const l = await listing(b, 1, 'ALL');
    await as(b, async (ctx) =>
      properties.saveListingTranslation(ctx, l.id, 'en', {
        version: (await properties.getListing(ctx, l.id)).version,
        title: `Villa ${RUN}`,
        description: DESCRIPTION,
      }),
    );
    await system((tx) => search.rebuildReadModels(tx, 'LISTING', [l.id]));
    // The worker's model pass found the indirect mention in b's description (S12-03), cached per target.
    await writeAiRemovals(
      { agencyId: b.agencyId, targetId: l.id },
      { version: 1, prompt: 1, texts: { [textKey(plainText(DESCRIPTION))]: [INDIRECT] } },
    );
    const provider = new FakeProvider(() =>
      JSON.stringify({ captions: [{ locale: 'en', text: 'A 4-bedroom villa with a pool.' }] }),
    );
    configureAi(
      createAiGateway({
        provider,
        models: { FAST: 'fast-model', SMART: 'smart-model' },
        pricing: { 'fast-model': { input: 1, output: 5 }, 'smart-model': { input: 5, output: 25 } },
        batchDiscountBp: 5_000,
        prompts: filePromptSource(PROMPTS_DIR),
        cache: memoryAiCache(),
        cacheTtlSeconds: 3_600,
        store: memoryAiStore(),
        budgetFor: () => ({ softMicroUsd: 1e12, hardMicroUsd: 2e12 }),
        timeoutMs: 5_000,
        breaker: { failures: 1_000, openMs: 1_000 },
        logger: log,
      }),
    );
    const accounts = (await connect(a)).items;
    const page = accounts.find((i) => i.platform === 'FACEBOOK_PAGE') as (typeof accounts)[number];
    // Captions input: the model never sees the indirect mention.
    const drafted = await as(a, (ctx) =>
      social.createSocialPost(ctx, { accountId: page.id, listingId: l.id, locale: 'en', captionLocales: ['en'] }),
    );
    const req = await latestEvent('social.captions.requested', 'postId', drafted.id);
    await social.generateCaptions({
      postId: drafted.id,
      agencyId: a.agencyId,
      requestId: req?.payload.requestId as string,
      locales: ['en'],
    });
    expect(provider.calls[0]?.user).toContain('4 bedrooms');
    expect(provider.calls[0]?.user).not.toContain('Marisol');
    // Published text: the agent pasted the owner's description as the caption — it goes out without the mention.
    const at = new Date(Date.now() + 60_000);
    const post = await as(a, (ctx) =>
      social.createSocialPost(ctx, {
        accountId: page.id,
        listingId: l.id,
        locale: 'en',
        caption: DESCRIPTION,
        scheduledAt: at.toISOString(),
      }),
    );
    await social.sweepDuePosts({ now: new Date(at.getTime() + 1_000) });
    const due = await latestEvent('social.post.due', 'postId', post.id);
    graph.calls.length = 0;
    expect(
      (
        await social.publishPost({
          postId: post.id,
          agencyId: a.agencyId,
          claimedAtMs: Number(due?.payload.claimedAtMs),
        })
      ).outcome,
    ).toBe('PUBLISHED');
    const sent = JSON.stringify(graph.publishes().map((c) => c.fields));
    expect(sent).toContain('4 bedrooms');
    expect(sent).not.toContain('Marisol');
  });

  it('[S12-07] scheduling and cancelling are audited; a disconnected account is hidden, then deleted, never revoked at Meta', async () => {
    const accounts = (await connect(a)).items;
    const page = accounts.find((i) => i.platform === 'FACEBOOK_PAGE') as (typeof accounts)[number];
    const ig = accounts.find((i) => i.platform === 'INSTAGRAM_BUSINESS') as (typeof accounts)[number];
    const l = await listing(a, 1);
    const post = await as(a, (ctx) =>
      social.createSocialPost(ctx, {
        accountId: page.id,
        listingId: l.id,
        locale: 'en',
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    await as(a, (ctx) => social.cancelSocialPost(ctx, post.id, { version: post.version }));
    const audits = await system(
      async (tx) =>
        (
          await tx.execute<{ type: string; metadata: Record<string, unknown> }>(
            sql`select type, metadata from audit_logs where target_id = ${post.id}::uuid order by occurred_at, id`,
          )
        ).rows,
    );
    expect(audits).toEqual([
      { type: 'social.post.scheduled', metadata: {} },
      { type: 'social.post.cancelled', metadata: {} },
    ]);

    // Disconnected: hidden at once, then deleted with its posts by the job. Meta is not called: the same login's
    // Instagram account is still connected (S13-F5 revokes only with the Meta user's last account).
    graph.calls.length = 0;
    await as(a, (ctx) => social.disconnectSocialAccount(ctx, page.id));
    expect((await as(a, (ctx) => social.listSocialAccounts(ctx))).items.map((i) => i.id)).not.toContain(page.id);
    expect(await countEvents('social.account.disconnected', 'accountId', page.id)).toBe(1);
    expect(await social.revokeAccount({ agencyId: a.agencyId, accountId: page.id })).toEqual({
      deleted: true,
      revoked: false,
    });
    expect(await postRow(post.id)).toBeUndefined();
    // Run again (a redelivered event): nothing more. The Instagram account is untouched.
    expect(await social.revokeAccount({ agencyId: a.agencyId, accountId: page.id })).toEqual({
      deleted: false,
      revoked: false,
    });
    expect((await as(a, (ctx) => social.listSocialAccounts(ctx))).items.map((i) => i.id)).toContain(ig.id);
    // Connected again before the job ran: kept.
    await as(a, (ctx) => social.disconnectSocialAccount(ctx, ig.id));
    await connect(a);
    expect(await social.revokeAccount({ agencyId: a.agencyId, accountId: ig.id })).toEqual({
      deleted: false,
      revoked: false,
    });
    expect((await as(a, (ctx) => social.listSocialAccounts(ctx))).items.map((i) => i.id)).toContain(ig.id);
    expect(graph.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });
});

describe('S13-F5 revoking the Meta grant', () => {
  let users = 0;
  /** A Meta user of its own for this run: rows left by earlier runs never count as its live accounts. */
  const metaUser = () => `7${Date.now()}${users++}`;
  const revokes = () => graph.calls.filter((c) => c.method === 'DELETE' && c.path === '/me/permissions');
  const pageOf = (items: Awaited<ReturnType<typeof connect>>['items'], platform: string) =>
    items.find((i) => i.platform === platform) as (typeof items)[number];
  const disconnectAll = async (m: Founder, items: Awaited<ReturnType<typeof connect>>['items']) => {
    for (const i of items) await as(m, (ctx) => social.disconnectSocialAccount(ctx, i.id));
  };

  it('[S13-F5] another agency’s account with the same Meta user keeps working; the last account of that user revokes once', async () => {
    const b = await createFounder();
    await setAgencyStatus(b.agencyId, 'VERIFIED');
    await enable(b, true);
    const user = metaUser();
    graph.userId = user;
    const ofA = (await connect(a)).items;
    const ofB = (await connect(b)).items;
    // The Meta user is stored with each account, hidden from the request role like the tokens.
    const stored = await system(
      async (tx) =>
        (
          await tx.execute<{ meta_user_id: string | null }>(
            sql`select meta_user_id from social_accounts where agency_id in (${a.agencyId}::uuid, ${b.agencyId}::uuid)`,
          )
        ).rows,
    );
    expect(stored.map((r) => r.meta_user_id)).toEqual([user, user, user, user]);
    await expect(
      as(a, (ctx) => ctx.tx.execute(sql`select meta_user_id from social_accounts where agency_id = ${a.agencyId}`)),
    ).rejects.toThrow();

    // Agency a disconnects both its accounts: deleted, but b still uses the same login, so the grant stays.
    graph.calls.length = 0;
    await disconnectAll(a, ofA);
    for (const i of ofA) {
      expect(await social.revokeAccount({ agencyId: a.agencyId, accountId: i.id })).toEqual({
        deleted: true,
        revoked: false,
      });
    }
    expect(revokes()).toHaveLength(0);
    // b's accounts are untouched and still publish.
    const listed = (await as(b, (ctx) => social.listSocialAccounts(ctx))).items;
    expect(listed.map((i) => [i.id, i.status])).toEqual(ofB.map((i) => [i.id, 'ACTIVE']));
    const l = await listing(b, 1);
    const at = new Date(Date.now() + 60_000);
    const post = await as(b, (ctx) =>
      social.createSocialPost(ctx, {
        accountId: pageOf(ofB, 'FACEBOOK_PAGE').id,
        listingId: l.id,
        locale: 'en',
        caption: 'Still connected',
        scheduledAt: at.toISOString(),
      }),
    );
    await social.sweepDuePosts({ now: new Date(at.getTime() + 1_000) });
    const due = await latestEvent('social.post.due', 'postId', post.id);
    const job = { postId: post.id, agencyId: b.agencyId, claimedAtMs: Number(due?.payload.claimedAtMs) };
    expect((await social.publishPost(job)).outcome).toBe('PUBLISHED');

    // b disconnects both: the Page's job finds the Instagram account (waiting for its own job) and only deletes; the
    // user's last account revokes the grant, once — with that account's user token, never a Page token.
    await disconnectAll(b, ofB);
    const [first, last] = [pageOf(ofB, 'FACEBOOK_PAGE'), pageOf(ofB, 'INSTAGRAM_BUSINESS')];
    expect(await social.revokeAccount({ agencyId: b.agencyId, accountId: first.id })).toEqual({
      deleted: true,
      revoked: false,
    });
    expect(revokes()).toHaveLength(0);
    expect(await social.revokeAccount({ agencyId: b.agencyId, accountId: last.id })).toEqual({
      deleted: true,
      revoked: true,
    });
    expect(revokes()).toHaveLength(1);
    expect(revokes()[0]?.fields.access_token).toMatch(/^long-\d+$/);
    expect(revokes()[0]?.fields.appsecret_proof).toMatch(/^[0-9a-f]{64}$/);
    expect(revokes()[0]?.fields.__secretInUrl).toBeUndefined();
    // A redelivered event: nothing left, nothing revoked again.
    expect(await social.revokeAccount({ agencyId: b.agencyId, accountId: last.id })).toEqual({
      deleted: false,
      revoked: false,
    });
    expect(revokes()).toHaveLength(1);
  });

  it('[S13-F5] a Meta outage retries the revoke and the last attempt deletes anyway; a refused token or an account without a Meta user deletes without revoking', async () => {
    // Outage: the job throws (it retries) and keeps the account; on its last attempt it deletes it.
    graph.userId = metaUser();
    let items = (await connect(a)).items;
    await disconnectAll(a, items);
    const [page, ig] = [pageOf(items, 'FACEBOOK_PAGE'), pageOf(items, 'INSTAGRAM_BUSINESS')];
    expect(await social.revokeAccount({ agencyId: a.agencyId, accountId: page.id })).toEqual({
      deleted: true,
      revoked: false,
    });
    const down = { status: 503, body: { error: { message: 'Service unavailable', code: 2 } } };
    const isRevoke = (c: { method: string; path: string }) => c.method === 'DELETE' && c.path === '/me/permissions';
    graph.failWith(isRevoke, down);
    await expect(social.revokeAccount({ agencyId: a.agencyId, accountId: ig.id })).rejects.toMatchObject({
      kind: 'UNAVAILABLE',
    });
    graph.failWith(isRevoke, down);
    expect(await social.revokeAccount({ agencyId: a.agencyId, accountId: ig.id }, { lastAttempt: true })).toEqual({
      deleted: true,
      revoked: false,
    });

    // Meta already refuses the user token: nothing left to revoke, deleted.
    graph.userId = metaUser();
    items = (await connect(a)).items;
    await disconnectAll(a, items);
    graph.failWith(isRevoke, EXPIRED_TOKEN);
    const results = [];
    for (const i of items) results.push(await social.revokeAccount({ agencyId: a.agencyId, accountId: i.id }));
    expect(results).toEqual([
      { deleted: true, revoked: false },
      { deleted: true, revoked: false },
    ]);

    // Both accounts' jobs at once: they take turns on the user's accounts, so one of them revokes.
    graph.userId = metaUser();
    items = (await connect(a)).items;
    await disconnectAll(a, items);
    graph.calls.length = 0;
    const together = await Promise.all(
      items.map((i) => social.revokeAccount({ agencyId: a.agencyId, accountId: i.id })),
    );
    expect(together.map((r) => r.deleted)).toEqual([true, true]);
    expect(together.filter((r) => r.revoked)).toHaveLength(1);
    expect(revokes()).toHaveLength(1);

    // Connected before S13-F5 (no Meta user stored): never revoked — it may share a login with other agencies.
    graph.userId = metaUser();
    items = (await connect(a)).items;
    await system((tx) =>
      tx.execute(sql`update social_accounts set meta_user_id = null where agency_id = ${a.agencyId}`),
    );
    await disconnectAll(a, items);
    graph.calls.length = 0;
    for (const i of items) await social.revokeAccount({ agencyId: a.agencyId, accountId: i.id });
    expect(revokes()).toHaveLength(0);
    expect((await as(a, (ctx) => social.listSocialAccounts(ctx))).items).toHaveLength(0);
  });

  it('[S13-F5] an account of the same Meta user connected while the revoke call runs is marked NEEDS_RECONNECT and announced', async () => {
    const b = await createFounder();
    await setAgencyStatus(b.agencyId, 'VERIFIED');
    await enable(b, true);
    const user = metaUser();
    graph.userId = user;
    const ofA = (await connect(a)).items;
    await disconnectAll(a, ofA);
    let ofB: Awaited<ReturnType<typeof connect>>['items'] = [];
    // During `DELETE /me/permissions` the same Meta user connects in agency b.
    graph.onCall = async (call) => {
      if (call.method !== 'DELETE' || call.path !== '/me/permissions') return;
      graph.onCall = undefined;
      ofB = (await connect(b)).items;
    };
    const results = [];
    for (const i of ofA) results.push(await social.revokeAccount({ agencyId: a.agencyId, accountId: i.id }));
    graph.onCall = undefined;
    expect(results.map((r) => r.deleted)).toEqual([true, true]);
    expect(results.filter((r) => r.revoked)).toHaveLength(1);
    expect(ofB.length).toBeGreaterThan(0);
    const listed = (await as(b, (ctx) => social.listSocialAccounts(ctx))).items;
    expect(listed.map((i) => i.status)).toEqual(ofB.map(() => 'NEEDS_RECONNECT'));
    for (const i of ofB) expect(await countEvents('social.account.needsReconnect', 'accountId', i.id)).toBe(1);
  });

  it('[S13-F5] a live account without a stored Meta user blocks the revoke until the backfill fills it; a refused token stays empty', async () => {
    const b = await createFounder();
    await setAgencyStatus(b.agencyId, 'VERIFIED');
    await enable(b, true);
    const userA = metaUser();
    const userB = metaUser();
    graph.userId = userA;
    const ofA = (await connect(a)).items;
    graph.userId = userB;
    const ofB = (await connect(b)).items;
    // b's accounts predate S13-F5 (no Meta user).
    await system((tx) =>
      tx.execute(sql`update social_accounts set meta_user_id = null where agency_id = ${b.agencyId}`),
    );
    await disconnectAll(a, ofA);
    graph.calls.length = 0;
    for (const i of ofA) {
      expect(await social.revokeAccount({ agencyId: a.agencyId, accountId: i.id })).toEqual({
        deleted: true,
        revoked: false,
      });
    }
    expect(revokes()).toHaveLength(0);

    const pending = async () =>
      system(
        async (tx) =>
          (
            await tx.execute<{ n: number }>(
              sql`select count(*)::int as n from social_accounts
                   where meta_user_id is null and user_token_enc is not null and status_reason is distinct from 'DISCONNECTED'`,
            )
          ).rows[0]?.n ?? 0,
      );
    const bUsers = async () =>
      system(async (tx) =>
        (
          await tx.execute<{ meta_user_id: string | null }>(
            sql`select meta_user_id from social_accounts where agency_id = ${b.agencyId}::uuid`,
          )
        ).rows.map((r) => r.meta_user_id),
      );
    // Meta refuses the tokens: left empty.
    graph.failWith((c) => c.method === 'GET' && c.path === '/me', EXPIRED_TOKEN, await pending());
    expect((await social.backfillMetaUsers()).filled).toBe(0);
    expect(await bUsers()).toEqual(ofB.map(() => null));
    // Then it fills them in.
    graph.userId = userB;
    const res = await social.backfillMetaUsers();
    expect(res.filled).toBeGreaterThanOrEqual(ofB.length);
    expect(await bUsers()).toEqual(ofB.map(() => userB));
    expect(await pending()).toBe(0);
    // Now b's last account revokes the grant.
    await disconnectAll(b, ofB);
    graph.calls.length = 0;
    const out = [];
    for (const i of ofB) out.push(await social.revokeAccount({ agencyId: b.agencyId, accountId: i.id }));
    expect(out.filter((r) => r.revoked)).toHaveLength(1);
    expect(revokes()).toHaveLength(1);
  });
});

describe('plan quota (S13-F21)', () => {
  it('[S13-F21] two concurrent connects cannot both take the plan social accounts (counted under a lock)', async () => {
    const catalog = JSON.parse(
      readFileSync(new URL('../../../../../../scripts/ops/billing-catalog.json', import.meta.url), 'utf8'),
    ) as { items: billing.CatalogInput[] };
    const f = await createFounder();
    await setAgencyStatus(f.agencyId, 'VERIFIED');
    await enable(f, true);
    await system(async (tx) => {
      await billing.upsertCatalog(tx, catalog.items, newId);
      // Pro: 2 social accounts.
      await tx.execute(sql`insert into billing_plan_grants (id, agency_id, kind, plan_code, starts_at, ends_at, reason)
        values (${newId()}, ${f.agencyId}, 'STAFF', 'pro', now() - interval '1 hour', now() + interval '30 days',
          'social quota test')`);
    });
    const digits = RUN.replace(/\D/g, '').padEnd(6, '3').slice(0, 6);
    const pageSet = (n: number) => [
      {
        id: `6${digits}${n}`,
        name: `Quota Page ${n} ${RUN}`,
        access_token: `quota-page-${n}`,
        instagram_business_account: { id: `5${digits}${n}`, username: `quota${n}` },
      },
    ];
    // Each callback's `/me/accounts` answers its own Page (and its Instagram account): 2 accounts each.
    const queue = [pageSet(1), pageSet(2)];
    graph.onCall = (call) => {
      if (call.path === '/me/accounts') graph.pages = queue.shift() ?? [];
    };
    billing.configureBilling({ enforcePlans: true });
    try {
      const results = await Promise.all([refusal(connect(f)), refusal(connect(f))]);
      expect(results.sort()).toEqual(['PLAN_REQUIRED', 'accepted']);
      const n = await system(
        async (tx) =>
          (
            await tx.execute<{ n: number }>(
              sql`select count(*)::int as n from social_accounts where agency_id = ${f.agencyId}::uuid`,
            )
          ).rows[0]?.n,
      );
      expect(n).toBe(2);
    } finally {
      graph.onCall = undefined;
      billing.configureBilling({});
    }
  });
});
