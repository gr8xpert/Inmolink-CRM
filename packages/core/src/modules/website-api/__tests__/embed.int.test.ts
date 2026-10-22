import {
  CreateListingBody,
  type CreateSiteInput,
  UpdateListingBody,
  WebsiteLeadBody,
  WebsiteListingsQuery,
} from '@inmolink/contracts';
import { closeDb, countQueries, withPublicRead, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { cache, closeCache, configureCache } from '@inmolink/platform/cache';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { closeRateLimit, configureRateLimit, rateLimiter } from '@inmolink/platform/rate-limit';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import type { TurnstileVerifier } from '@inmolink/platform/turnstile';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import { whiteLabelLeaks } from '../../../testing/white-label';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as websites from '../../websites';
import { EMBED_MISS_TTL_MS, EMBED_PAGE_LIMITS, resetEmbedMisses } from '../embed';
import * as websiteApi from '../index';

/**
 * iFrame embed pages' service side (S7-F8): which sites may be embedded (IFRAME mode, verified agency, a domain to
 * frame them), what they read (the website API's own path — white-label, ≤ 3 statements) and where their leads go
 * (the S7-05 intake: Turnstile on the public pages host, the presenting agency).
 */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-emb-${RUN}`;
const EMBED_ORIGIN = 'https://sites.inmolink.test';
const OWNER_NAME = `Ownerhaus Embed ${RUN}`;
const OWNER_MAIL = `sales-${RUN.toLowerCase()}@ownerhaus-embed.example`;

/** a: the site's agency · b: a network owner whose identity must never reach a's embed pages. */
let a: Founder;
let b: Founder;
let ids: { country: string; city: string; villa: string };
const L = { aVilla: '', bVilla: '' };
const S = { embed: '', wp: '', noDomain: '' };

const usedTokens = new Set<string>();
const turnstileCalls: { token: string; action: string; hostnames?: readonly string[] }[] = [];
const turnstile: TurnstileVerifier = {
  async verify(token, options) {
    turnstileCalls.push({ token, ...options });
    const fresh = !usedTokens.has(token);
    usedTokens.add(token);
    return (
      fresh &&
      token.startsWith('good') &&
      options.action === websiteApi.LEAD_TURNSTILE_ACTION &&
      (options.hostnames ?? []).includes(new URL(EMBED_ORIGIN).hostname)
    );
  },
};
const configure = (embedOrigin?: string) =>
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
    turnstile,
    ...(embedOrigin ? { embedOrigin } : {}),
  });

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('embed.test', fn);

async function listing(m: Founder, priceCents: number, description: string): Promise<string> {
  const { id } = await as(m, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({ propertyTypeId: ids.villa, locationId: ids.city, priceCents, energyRating: 'B' }),
    ),
  );
  await as(m, async (ctx) =>
    properties.saveListingTranslation(ctx, id, 'en', {
      version: (await properties.getListing(ctx, id)).version,
      title: `Villa ${RUN}`,
      description,
    }),
  );
  await as(m, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility: 'PUBLIC',
        shareScope: 'ALL',
        version: (await properties.getListing(ctx, id)).version,
      }),
    ),
  );
  return id;
}

const SITE: CreateSiteInput = {
  name: 'Costa Embed',
  domains: ['www.costa-embed.example', 'costa-embed.example'],
  mode: 'IFRAME',
  inventoryPolicy: 'CUSTOM',
  inventoryFilters: null,
  referencePrefix: 'CE',
  locales: ['en', 'es'],
  contact: { name: 'Costa Embed Homes', email: 'hello@costa-embed.example', phone: '+34 600 000 009' },
};

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'served';
}

const codeOf = async (id: string) => (await withPublicRead((tx) => search.publicCodes(tx, [id]))).get(id) as string;
const embed = (siteId: string) => websiteApi.embedSite(siteId, newId());
const dropSiteCache = (siteId: string) => cache.delete(websites.siteCacheKey(siteId));

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:embed:${RUN}` });
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
  configure(EMBED_ORIGIN);
  search.configureNetworkSearch({ giveToGetMinShared: 1, giveToGetGraceDays: 0 });
  // The engine is unreachable: website search answers from the Postgres fallback (the same read path otherwise).
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  search.resetSearchBreaker();
  a = await createFounder();
  b = await createFounder({ companyName: OWNER_NAME });
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: code(n.toLowerCase()) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('c'),
      translations: name('Embedland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('r'),
      translations: name('Coast'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('ci'),
      translations: name('Harbour'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, { key: code('g'), sort: 0, translations: name('Homes') });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('v'),
      sort: 0,
      translations: name('Villa'),
    });
    return { country, city, villa };
  });
  L.aVilla = await listing(a, 30_000_000, 'Sunny villa with a pool.');
  L.bVilla = await listing(b, 45_000_000, `Call ${OWNER_NAME} at ${OWNER_MAIL} or visit www.ownerhaus-embed.example.`);
  await system((tx) => search.rebuildReadModels(tx, 'LISTING', Object.values(L)));
  const filters = {
    includeOwn: true,
    includeNetwork: true,
    locationIds: [ids.country],
    propertyTypeIds: [],
    newBuilds: true,
  };
  S.embed = (await as(a, (ctx) => websites.createSite(ctx, { ...SITE, inventoryFilters: filters }))).id;
  S.wp = (await as(a, (ctx) => websites.createSite(ctx, { ...SITE, mode: 'WP_PLUGIN', inventoryFilters: filters }))).id;
  S.noDomain = (await as(a, (ctx) => websites.createSite(ctx, { ...SITE, domains: [], inventoryFilters: filters }))).id;
}, 180_000);

beforeEach(() => {
  configure(EMBED_ORIGIN);
  turnstileCalls.length = 0;
});

afterAll(async () => {
  await closeRateLimit();
  await closeCache();
  await closeDb();
});

describe('iFrame embed pages — service side (S7-F8)', () => {
  it('[S7-F8] embed identity: only an IFRAME site of a verified agency with a domain is served; others 404 alike', async () => {
    // Branding is checked, never fetched: no server-side request (a logo URL would only go through safeFetch).
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const site = await embed(S.embed);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(site.frameAncestors).toEqual(['https://www.costa-embed.example', 'https://costa-embed.example']);
    expect(site.branding).toMatchObject({ name: 'Costa Embed Homes', email: 'hello@costa-embed.example' });
    expect(site.api.scope.agencyId).toBe(a.agencyId);
    // Not opted in (another mode), nowhere to be framed, unknown or malformed: the same refusal.
    expect(await refusal(embed(S.wp))).toBe('SITE_NOT_FOUND');
    expect(await refusal(embed(S.noDomain))).toBe('SITE_NOT_FOUND');
    expect(await refusal(embed(newId()))).toBe('SITE_NOT_FOUND');
    expect(await refusal(embed('../../etc/passwd'))).toBe('SITE_NOT_FOUND');
    // A suspended agency's site is refused (its cached scope follows within the site cache's TTL).
    await setAgencyStatus(a.agencyId, 'SUSPENDED');
    await dropSiteCache(S.embed);
    expect(await refusal(embed(S.embed))).toBe('SITE_NOT_FOUND');
    await setAgencyStatus(a.agencyId, 'VERIFIED');
    await dropSiteCache(S.embed);
    expect((await embed(S.embed)).siteId).toBe(S.embed);
    // A deleted site (gone with its agency's deletion) is refused.
    const gone = (
      await as(a, (ctx) => websites.createSite(ctx, { ...SITE, inventoryPolicy: 'OWN_ONLY', inventoryFilters: null }))
    ).id;
    expect((await embed(gone)).siteId).toBe(gone);
    await system((tx) => tx.execute(sql`delete from website_sites where id = ${gone}`));
    await dropSiteCache(gone);
    expect(await refusal(embed(gone))).toBe('SITE_NOT_FOUND');
  });

  it('[S7-F8] the detail of a network listing is white-labelled (shared check), within 3 statements', async () => {
    const site = await embed(S.embed);
    const ref = `CE-${await codeOf(L.bVilla)}`;
    const ownerRef = (await as(b, (ctx) => properties.getListing(ctx, L.bVilla))).ref as string;
    // Warm the site's network gate (cached), as any page after the first.
    await websiteApi.embedDetail(site, ref, 'en');
    let detail: Awaited<ReturnType<typeof websiteApi.embedDetail>> | undefined;
    const statements = await countQueries(async () => {
      detail = await websiteApi.embedDetail(await embed(S.embed), ref, 'en');
    });
    expect(statements).toBeLessThanOrEqual(3);
    expect(detail?.ref).toBe(ref);
    expect(detail?.agency.name).toBe('Costa Embed Homes');
    expect(
      whiteLabelLeaks(detail, {
        name: OWNER_NAME,
        email: OWNER_MAIL,
        domain: 'ownerhaus-embed.example',
        ref: ownerRef,
        agencyId: b.agencyId,
      }),
    ).toEqual([]);
    // The search page: the site's inventory, own and network, white-labelled the same way.
    const page = await websiteApi.embedSearch(site, WebsiteListingsQuery.parse({ lang: 'en', limit: 24 }));
    expect(page.items.map((i) => i.ref).sort()).toEqual(
      [ref, (await as(a, (ctx) => properties.getListing(ctx, L.aVilla))).ref as string].sort(),
    );
  });

  it('[S7-F8] a lead from the embed form reaches the presenting agency through the S7-05 intake (Turnstile on the pages host)', async () => {
    const site = await embed(S.embed);
    const ref = `CE-${await codeOf(L.bVilla)}`;
    const body = WebsiteLeadBody.parse({
      name: 'Ana Buyer',
      email: `ana-${RUN.toLowerCase()}@example.com`,
      privacyAccepted: true,
      ref,
      lang: 'en',
      message: 'Is it still available?',
      turnstileToken: `good-${newId()}`,
    });
    const { accepted, created } = await websiteApi.submitEmbedLead(
      site,
      { kind: 'ENQUIRY', body },
      { ip: '203.0.113.7', idempotencyKey: `embed-${newId()}` },
    );
    expect(created).toBe(true);
    expect(turnstileCalls.at(-1)).toMatchObject({
      action: websiteApi.LEAD_TURNSTILE_ACTION,
      hostnames: ['sites.inmolink.test'],
    });
    const row = (
      await system((tx) =>
        tx.execute<{ agency_id: string; owner_agency_id: string | null; site_id: string; verification: string }>(
          sql`select agency_id, owner_agency_id, site_id, verification from website_leads where id = ${accepted.id}`,
        ),
      )
    ).rows[0];
    expect(row).toEqual({
      agency_id: a.agencyId,
      owner_agency_id: b.agencyId,
      site_id: S.embed,
      verification: 'TURNSTILE',
    });
    // A failed or missing challenge is refused; without the pages origin configured, embed forms fail closed.
    const bad = { ...body, turnstileToken: 'bad-token' };
    expect(
      await refusal(
        websiteApi.submitEmbedLead(site, { kind: 'ENQUIRY', body: bad }, { idempotencyKey: `embed-${newId()}` }),
      ),
    ).toBe('TURNSTILE_FAILED');
    configure();
    const fresh = { ...body, turnstileToken: `good-${newId()}` };
    expect(
      await refusal(
        websiteApi.submitEmbedLead(site, { kind: 'ENQUIRY', body: fresh }, { idempotencyKey: `embed-${newId()}` }),
      ),
    ).toBe('TURNSTILE_FAILED');
  });

  it('[S7-F8] unknown site ids are cached as missing for 60 s: a flood of one made-up id reaches the database once', async () => {
    resetEmbedMisses();
    const unknown = newId();
    expect(await countQueries(() => refusal(websiteApi.embedSiteScope(unknown)))).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) {
      expect(await countQueries(() => refusal(websiteApi.embedSiteScope(unknown)))).toBe(0);
    }
    expect(EMBED_MISS_TTL_MS).toBe(60_000);
    // An existing embeddable site is not affected.
    expect((await websiteApi.embedSiteScope(S.embed)).scope.siteId).toBe(S.embed);
  });

  it('[S7-F8] embed page views and lead posts are limited per client IP', async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 250)}-${RUN}`;
    const limiter = rateLimiter();
    for (let i = 0; i < EMBED_PAGE_LIMITS.perMinute; i++) {
      expect((await websiteApi.checkEmbedLimits(limiter, { ip })).allowed).toBe(true);
    }
    const over = await websiteApi.checkEmbedLimits(limiter, { ip });
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSeconds).toBeGreaterThan(0);
    // Lead posts: the website forms' per-browser figure (5 per 10 minutes by default), per site × IP.
    const writer = `198.51.100.1-w-${RUN}`;
    const posts: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      posts.push((await websiteApi.checkEmbedLimits(limiter, { ip: writer, write: { siteId: S.embed } })).allowed);
    }
    expect(posts).toEqual([true, true, true, true, true, false]);
  });
});
