import { gunzipSync } from 'node:zlib';
import { CreatePortalConnectionBody } from '@inmolink/contracts';
import { closeDb, withMemberCtx } from '@inmolink/core';
import * as exportsModule from '@inmolink/core/modules/exports';
import { configurePortalFeeds, generatePortalFeeds } from '@inmolink/core/modules/exports/worker';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { createFounder, type Founder, withSystem } from '@inmolink/core/test';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { configureStorage, createMemoryStore } from '@inmolink/platform/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

/**
 * Portal feeds over HTTP (S9-03): `GET /v2/portal-feeds/{token}/{file}` — no API key (the token URL is the
 * credential), gzip for the CDN and decompressed for clients without it, a strong ETag (the content hash) per
 * encoding, public for the CDN only with the edge cache on, never indexed; unknown tokens and the other format's file
 * 404. Object storage is the platform's memory store.
 */

const RUN = newId().slice(-8);
const KEY = 'test-hmac-key-0123456789abcdef0123456789';
const limited: { rule: string; identity: string; limit: number }[] = [];
const allow = {
  consume: async (rule: { name: string; limit: number }, identity: string) => {
    limited.push({ rule: rule.name, identity, limit: rule.limit });
    return { allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 };
  },
  credit: async () => undefined,
  consumeMany: async (checks: readonly unknown[]) =>
    checks.map(() => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0, resetAtMs: 0 })),
} as unknown as RateLimiter;

let edge: Awaited<ReturnType<typeof buildApp>>;
let origin: Awaited<ReturnType<typeof buildApp>>;
let a: Founder;
let token = '';

const app = (edgeCache: boolean, portalFeedIpPerMinute?: number) =>
  buildApp({
    portalFeedIpPerMinute,
    logger: createLogger({ service: 'feed-api-test', level: 'silent' }),
    trustProxy: false,
    docsUi: false,
    checks: {},
    limiter: allow,
    edgeCache,
  });

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:portal-xml:${RUN}` });
  exportsModule.configureExports({
    keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }),
    tokenKey: KEY,
  });
  configurePortalFeeds({ mediaBaseUrl: 'https://media.example' });
  configureStorage(createMemoryStore());
  await withSystem('feed-api.portal-feeds.test', (tx) => exportsModule.syncPortalChannels(tx));
  a = await createFounder();
  await setAgencyStatus(a.agencyId, 'VERIFIED');
  const created = await withMemberCtx(
    { userId: a.userId, agencyId: a.agencyId, requestId: newId(), locale: 'en' },
    (ctx) => exportsModule.createConnection(ctx, CreatePortalConnectionBody.parse({ channelCode: 'kyero', name: 'K' })),
  );
  token = created.token;
  const run = await generatePortalFeeds(a.agencyId, { trigger: 'EVENT' });
  expect(run.written).toEqual([created.connection.id]);
  // Tags after the run (the worker's purge queue is not part of this app): the answers carry them.
  websiteApi.configureEdgeCache({ tagKey: 'test-edge-key-0123456789abcdef0123456789' });
  edge = await app(true);
  origin = await app(false);
}, 120_000);

afterAll(async () => {
  await edge?.close();
  await origin?.close();
  await closeCache();
  await closeDb();
});

describe('[S9-03] portal feeds at tokenized URLs', () => {
  it('[S9-03] serves the stored gzip with a strong ETag, CDN-cacheable like the site feeds, and answers 304', async () => {
    limited.length = 0;
    const res = await edge.inject({
      method: 'GET',
      url: `/v2/portal-feeds/${token}/kyero.xml`,
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(res.headers['cache-control']).toBe(
      `public, max-age=0, s-maxage=${exportsModule.PORTAL_FEED_TTL}, stale-while-revalidate=${exportsModule.PORTAL_FEED_TTL}, stale-if-error=${exportsModule.PORTAL_FEED_STALE_IF_ERROR}`,
    );
    expect(res.headers.etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(res.headers['cache-tag']).toMatch(/^p[0-9a-f]{20}$/);
    expect(res.headers.vary).toBe('Accept-Encoding');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(gunzipSync(res.rawPayload).toString('utf8')).toContain('<kyero><feed_version>3</feed_version></kyero>');
    // The per-token limit counts a hash of the token, never the token.
    const perToken = limited.find((l) => l.rule === 'portal-feed.xml.token');
    // Per IP: the configurable portal ceiling (default 3,000 / min); per token: 60 / hour.
    expect(limited.find((l) => l.rule === 'portal-feed.xml.ip')?.limit).toBe(3_000);
    expect(perToken?.limit).toBe(60);
    expect(perToken?.identity).toMatch(/^portal-feed:/);
    expect(JSON.stringify(limited)).not.toContain(token);

    const again = await edge.inject({
      method: 'GET',
      url: `/v2/portal-feeds/${token}/kyero.xml`,
      headers: { 'accept-encoding': 'gzip', 'if-none-match': res.headers.etag as string },
    });
    expect(again.statusCode).toBe(304);

    const plain = await edge.inject({ method: 'GET', url: `/v2/portal-feeds/${token}/kyero.xml` });
    expect(plain.statusCode).toBe(200);
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.headers.etag).toBe(`${(res.headers.etag as string).slice(0, -1)}.identity"`);
    expect(plain.payload).toContain('<root>');
  });

  it('[S9-03] the per-IP portal feed limit is configurable (PORTAL_FEED_IP_PER_MINUTE)', async () => {
    const tuned = await app(true, 12_000);
    try {
      limited.length = 0;
      await tuned.inject({ method: 'GET', url: `/v2/portal-feeds/${token}/kyero.xml` });
      expect(limited.find((l) => l.rule === 'portal-feed.xml.ip')?.limit).toBe(12_000);
    } finally {
      await tuned.close();
    }
  });

  it('[S9-03] with the edge cache off, gzip polls are redirected to a short-lived signed storage URL', async () => {
    const res = await origin.inject({
      method: 'GET',
      url: `/v2/portal-feeds/${token}/kyero.xml`,
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.location).toMatch(/^memory:\/\//);
  });

  it('[S9-03] unknown tokens and the other format’s file answer the same 404, never cached publicly', async () => {
    for (const url of [`/v2/portal-feeds/${token}/inmolink.xml`, `/v2/portal-feeds/${'A'.repeat(43)}/kyero.xml`]) {
      const res = await edge.inject({ method: 'GET', url, headers: { 'accept-encoding': 'gzip' } });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error.code).toBe('PORTAL_FEED_NOT_FOUND');
      expect(String(res.headers['cache-control'])).not.toContain('public');
    }
    const bad = await edge.inject({ method: 'GET', url: `/v2/portal-feeds/${token}/feed.csv` });
    expect(bad.statusCode).toBe(422);
  });
});
