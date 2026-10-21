import { type WebsiteCard, WebsiteListingCard } from '@inmolink/contracts';
import type { RateLimitCheck, RateLimiter, RateLimitResult, RateLimitRule } from '@inmolink/platform/rate-limit';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiKeyPrincipal } from '../../identity';
import { wrapSearchCursor } from '../cursor';
import {
  honeytokenCard,
  honeytokenCode,
  honeytokenKind,
  honeytokenSiteOf,
  isHoneytokenCode,
  isHoneytokenRef,
  withHoneytoken,
} from '../honeytokens';
import { checkWebsiteLimits, websiteRequestChecks } from '../limits';
import { configureWebsiteApi, type WebsiteAlert } from '../settings';

/** Quotas, paging rules and honeytokens (S7-04) without Redis: a scripted limiter. */

const KEY = 'test-cursor-key-0123456789abcdef0123';
const alerts: WebsiteAlert[] = [];

beforeEach(() => {
  alerts.length = 0;
  configureWebsiteApi({ mediaBaseUrl: 'https://media.example', cursorKey: KEY, onAlert: (a) => alerts.push(a) });
});

const secret: ApiKeyPrincipal = {
  keyId: '01900000-0000-7000-8000-000000000001',
  agencyId: '01900000-0000-7000-8000-0000000000a1',
  kind: 'SECRET',
  scopes: ['listings:read'],
  rateTier: 'STANDARD',
  siteId: '01900000-0000-7000-8000-000000000051',
};
const widget: ApiKeyPrincipal = { ...secret, keyId: '01900000-0000-7000-8000-000000000002', kind: 'PUBLISHABLE' };
const facts = { ip: '203.0.113.7', paged: true, requestId: 'req-1' };

/** Answers each rule from `script` (by rule name); allowed with nothing used otherwise. Records what was sent. */
function scripted(
  script: Record<string, Partial<RateLimitResult>>,
  seen: { checks: RateLimitCheck[]; slot?: string }[] = [],
): RateLimiter {
  const consume = (rule: RateLimitRule): RateLimitResult => ({
    allowed: true,
    limit: rule.limit,
    remaining: rule.limit,
    retryAfterSeconds: 0,
    resetAtMs: 0,
    ...script[rule.name],
  });
  return {
    consumeMany: async (checks: readonly RateLimitCheck[], options: { slot?: string } = {}) => {
      seen.push({ checks: [...checks], slot: options.slot });
      return checks.map((c) => consume(c.rule));
    },
  } as unknown as RateLimiter;
}

describe('website API limits (S7-04)', () => {
  it('[S7-04] secret keys: key-wide burst and quota; publishable keys: per browser, key-wide only alerts; deep paging rules', () => {
    const names = (k: ApiKeyPrincipal, paged: boolean, depth = 0) =>
      websiteRequestChecks(k, { ip: facts.ip, paged, depth }).map((c) => `${c.rule.name}:${c.role}`);
    expect(names(secret, false)).toEqual([
      'feed.key.standard:enforce',
      'feed.agency:enforce',
      'feed.burst.standard:enforce',
      'feed.quota.standard:quota',
    ]);
    // Volume never flags a secret key: paging adds nothing until a cursor chain is deep.
    expect(names(secret, true, 49)).toEqual(names(secret, false));
    expect(names(secret, true, 50)).toEqual([...names(secret, false), 'feed.deep.flag:flag', 'feed.deep:throttle']);
    expect(names(widget, true)).toEqual([
      'feed.key.standard:enforce',
      'feed.agency:enforce',
      'feed.burst.standard:observe',
      'feed.quota.standard:observe',
      'feed.browser:enforce',
      'feed.browser.burst:enforce',
      'feed.browser.day:quota',
      'feed.paging.browser.flag:flag',
      'feed.paging.browser:throttle',
      'feed.paging.pk.standard:observe',
    ]);
    const quota = websiteRequestChecks(secret, facts).find((c) => c.role === 'quota');
    expect(quota?.rule).toMatchObject({ windowSeconds: 86_400, fixedWindow: true, limit: 100_000 });
    // The browser's identity is the key and the client IP together: one page's visitors do not share it.
    const browser = websiteRequestChecks(widget, facts).find((c) => c.rule.name === 'feed.browser');
    expect(browser?.identity).toBe(`${widget.keyId}|${facts.ip}`);
  });

  it('[S7-04] one call in the agency slot; quotas count last; alert-only rules never refuse', async () => {
    const seen: { checks: RateLimitCheck[]; slot?: string }[] = [];
    await checkWebsiteLimits(scripted({}, seen), widget, facts);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.slot).toBe(widget.agencyId);
    const sent = Object.fromEntries((seen[0]?.checks ?? []).map((c) => [c.rule.name, c]));
    expect(sent['feed.browser.day']).toMatchObject({ countLast: true, observe: false });
    expect(sent['feed.quota.standard']).toMatchObject({ countLast: false, observe: true });
    expect(sent['feed.browser']).toMatchObject({ countLast: false, observe: false });
    // The publishable key's key-wide quota and burst over: alert, not 429.
    const over = await checkWebsiteLimits(
      scripted({
        'feed.quota.standard': { allowed: false, remaining: 0, retryAfterSeconds: 9, tripped: true },
        'feed.burst.standard': { allowed: false, remaining: 0, retryAfterSeconds: 9, penalized: true },
      }),
      widget,
      facts,
    );
    expect(over).toEqual({ allowed: true, suspicious: false });
    expect(alerts).toEqual([expect.objectContaining({ action: 'observed', rule: 'feed.quota.standard' })]);
  });

  it('[S7-04] exceeding the daily quota is a quota answer with its reset time', async () => {
    const midnight = Date.UTC(2026, 9, 22);
    const quota = { allowed: false, remaining: 0, retryAfterSeconds: 3_600, resetAtMs: midnight };
    const decision = await checkWebsiteLimits(scripted({ 'feed.quota.standard': quota }), secret, {
      ...facts,
      paged: false,
    });
    expect(decision).toEqual({
      allowed: false,
      kind: 'quota',
      scope: 'key',
      limit: 100_000,
      resetAtMs: midnight,
      retryAfterSeconds: 3_600,
    });
    // A browser's daily share is a quota answer too, scoped to the browser.
    const share = await checkWebsiteLimits(scripted({ 'feed.browser.day': quota }), widget, facts);
    expect(share).toMatchObject({ allowed: false, kind: 'quota', scope: 'ip', resetAtMs: midnight });
    // A burst denial is a rate answer.
    const burst = await checkWebsiteLimits(
      scripted({ 'feed.burst.standard': { allowed: false, remaining: 0, retryAfterSeconds: 2 } }),
      secret,
      facts,
    );
    expect(burst).toMatchObject({ allowed: false, kind: 'rate', scope: 'key', retryAfterSeconds: 2 });
  });

  it('[S7-04] a busy secret key with many shallow pagers is not suspicious; a deep cursor chain is', async () => {
    // Every paging counter near its top: volume alone says nothing about a secret key.
    const busy = scripted({
      'feed.key.standard': { remaining: 1 },
      'feed.burst.standard': { remaining: 1 },
    });
    const cursorAt = (depth: number) => wrapSearchCursor(secret.siteId as string, depth, 'inner-cursor');
    for (const depth of [1, 9, 10, 49]) {
      expect(await checkWebsiteLimits(busy, secret, { ...facts, listingsCursor: cursorAt(depth) })).toEqual({
        allowed: true,
        suspicious: false,
      });
    }
    expect(alerts).toEqual([]);
    expect(await checkWebsiteLimits(busy, secret, { ...facts, listingsCursor: cursorAt(50) })).toEqual({
      allowed: true,
      suspicious: true,
    });
    // A forged depth is no depth.
    const forged = `${cursorAt(50).slice(0, 3)}${'x'.repeat(11)}inner-cursor`;
    expect(await checkWebsiteLimits(busy, secret, { ...facts, listingsCursor: forged })).toEqual({
      allowed: true,
      suspicious: false,
    });
  });

  it('[S7-04] flags and throttles: a flag alerts and makes the caller suspicious; a throttle refuses and alerts', async () => {
    const flagged = await checkWebsiteLimits(
      scripted({
        'feed.paging.browser.flag': { allowed: false, remaining: 0, retryAfterSeconds: 3_600, tripped: true },
      }),
      widget,
      facts,
    );
    expect(flagged).toEqual({ allowed: true, suspicious: true });
    expect(alerts).toEqual([expect.objectContaining({ action: 'flagged', scope: 'browser', keyKind: 'PUBLISHABLE' })]);
    // Still flagged: suspicious, no second alert.
    alerts.length = 0;
    const still = await checkWebsiteLimits(
      scripted({
        'feed.paging.browser.flag': { allowed: false, remaining: 0, retryAfterSeconds: 99, penalized: true },
      }),
      widget,
      facts,
    );
    expect(still).toEqual({ allowed: true, suspicious: true });
    expect(alerts).toEqual([]);

    const throttled = await checkWebsiteLimits(
      scripted({ 'feed.paging.browser': { allowed: false, remaining: 0, retryAfterSeconds: 3_600, tripped: true } }),
      widget,
      facts,
    );
    expect(throttled).toMatchObject({ allowed: false, kind: 'rate', scope: 'ip', retryAfterSeconds: 3_600 });
    expect(alerts).toEqual([expect.objectContaining({ action: 'throttled', scope: 'browser' })]);

    alerts.length = 0;
    const deep = await checkWebsiteLimits(
      scripted({ 'feed.deep': { allowed: false, remaining: 0, retryAfterSeconds: 3_600, tripped: true } }),
      secret,
      { ...facts, listingsCursor: wrapSearchCursor(secret.siteId as string, 60, 'inner') },
    );
    expect(deep).toMatchObject({ allowed: false, scope: 'key' });
    expect(alerts).toEqual([expect.objectContaining({ action: 'throttled', scope: 'key', keyKind: 'SECRET' })]);

    const observed = await checkWebsiteLimits(
      scripted({
        'feed.paging.pk.standard': { allowed: false, remaining: 0, retryAfterSeconds: 3_600, tripped: true },
      }),
      widget,
      facts,
    );
    expect(observed).toEqual({ allowed: true, suspicious: false });
  });
});

const SITE = { siteId: '01900000-0000-7000-8000-0000000000b1', referencePrefix: 'CH' };
const taxon = (name: string) => ({ id: '01900000-0000-7000-8000-00000000c0de', name, slug: name.toLowerCase() });

function card(i: number, over: Partial<WebsiteListingCard> = {}): WebsiteListingCard {
  return WebsiteListingCard.parse({
    kind: 'LISTING',
    id: `01900000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    ref: `CH-${String(i).padStart(4, '0')}ABCD`.slice(0, 11),
    status: 'ACTIVE',
    transactionType: 'SALE',
    price: { amountCents: 45_000_000 + i * 1_000_000, currency: 'EUR', period: null, onRequest: false },
    propertyType: taxon('Villa'),
    place: { country: taxon('Spain'), region: null, city: taxon('Marbella'), area: null },
    bedrooms: 3,
    bathrooms: 2,
    builtM2: 180,
    plotM2: 900,
    geo: { lat: 36.51, lng: -4.88, precision: 'APPROX' },
    cover: null,
    imageCount: 12,
    developmentId: null,
    title: `Villa with sea views ${i}`,
    slug: `villa-with-sea-views-${i}`,
    textLocale: null,
    developmentRef: null,
    ...over,
  });
}

describe('honeytokens (S7-04)', () => {
  it('[S7-04] codes are per site, recognisable from the reference alone, and look like public codes', () => {
    const code = honeytokenCode(KEY, SITE.siteId, 'CH-0001ABCD');
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(honeytokenCode(KEY, SITE.siteId, 'CH-0001ABCD')).toBe(code);
    expect(isHoneytokenCode(KEY, SITE.siteId, code)).toBe(true);
    expect(isHoneytokenCode(KEY, '01900000-0000-7000-8000-0000000000b2', code)).toBe(false);
    expect(isHoneytokenRef(KEY, SITE, `CH-${code}`)).toBe(true);
    expect(isHoneytokenRef(KEY, SITE, `ch-${code.toLowerCase()}`)).toBe(true);
    expect(isHoneytokenRef(KEY, SITE, `XX-${code}`)).toBe(false);
    expect(isHoneytokenRef(KEY, SITE, code)).toBe(false);
    expect(honeytokenSiteOf(KEY, ['01900000-0000-7000-8000-0000000000b2', SITE.siteId], code)).toBe(SITE.siteId);
    // Real (random) codes are almost never taken for one: the check half is 20 bits.
    let false_ = 0;
    for (let i = 0; i < 5_000; i++) {
      const random = Array.from(
        { length: 8 },
        (_, j) => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[(i * 7 + j * 13 + i * j) % 32],
      ).join('');
      if (isHoneytokenCode(KEY, SITE.siteId, random)) false_++;
    }
    expect(false_).toBeLessThanOrEqual(1);
  });

  it('[S7-04] a honeytoken is a white-label-safe clone: strict card, only what the page already shows, its own id and reference', () => {
    const real = card(1, { cover: null });
    const token = honeytokenCard(KEY, SITE, real);
    expect(WebsiteListingCard.parse(token)).toEqual(token);
    expect(token.id).not.toBe(real.id);
    expect(token.ref).toMatch(/^CH-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(token.ref).not.toBe(real.ref);
    // Texts, place and type come from the card the site already serves (white-labelled by the serializer).
    expect({ title: token.title, slug: token.slug, place: token.place, type: token.propertyType }).toEqual({
      title: real.title,
      slug: real.slug,
      place: real.place,
      type: real.propertyType,
    });
    expect(Object.keys(token).sort()).toEqual(Object.keys(real).sort());
    // Facts are shifted, never near-copies: 2–9 % on the price, 2–8 % on sizes, a different point.
    const realPrice = real.price.amountCents as number;
    const shift = Math.abs((token.price.amountCents as number) - realPrice) / realPrice;
    expect(shift).toBeGreaterThan(0.01);
    expect(shift).toBeLessThanOrEqual(0.1);
    expect((token.price.amountCents as number) % 100_000).toBe(0);
    expect(token.builtM2).not.toBe(real.builtM2);
    expect(token.geo).not.toEqual(real.geo);
    // The same real card always gives the same honeytoken.
    expect(honeytokenCard(KEY, SITE, real)).toEqual(token);
  });

  it('[S7-04] on an own card the honeytoken keeps the agency’s reference style, recognisable by its check digits', () => {
    const own = card(5, { ref: 'R4123456' });
    const token = honeytokenCard(KEY, SITE, own);
    expect(token.ref).toMatch(/^R\d{7}$/);
    expect(token.ref).not.toBe(own.ref);
    expect(honeytokenKind(KEY, SITE, token.ref)).toEqual({ style: 'own' });
    expect(honeytokenKind(KEY, SITE, own.ref)).toBeNull();
    // Too few digits to carry a check: the network style instead.
    expect(honeytokenCard(KEY, SITE, card(6, { ref: 'VILLA-12' })).ref).toMatch(/^CH-[0-9A-HJKMNP-TV-Z]{8}$/);
    // A code-style one says which code to confirm against the real ones.
    const coded = honeytokenCard(KEY, SITE, card(7)).ref;
    expect(honeytokenKind(KEY, SITE, coded)).toEqual({ style: 'code', code: coded.slice(3) });
  });

  it('[S7-04] pages: one card replaced by its own clone (the page keeps its size), the same for the same cursor', () => {
    const items: WebsiteCard[] = [card(1), card(2), card(3)];
    const page = withHoneytoken(KEY, SITE, 'cursor-a', items);
    expect(page).toHaveLength(3);
    const replaced = items.findIndex((c, i) => page[i] !== c);
    const token = page[replaced] as WebsiteListingCard;
    expect(isHoneytokenRef(KEY, SITE, token.ref)).toBe(true);
    // Cloned from the card it replaced: no near-duplicate of it left on the page.
    expect(token.title).toBe((items[replaced] as WebsiteListingCard).title);
    expect(page.filter((c) => c.title === token.title)).toHaveLength(1);
    expect(withHoneytoken(KEY, SITE, 'cursor-a', items)).toEqual(page);
    // Cards inside developments are never cloned.
    const inDevelopment = [card(4, { developmentId: '01900000-0000-7000-8000-0000000000d1' })];
    expect(withHoneytoken(KEY, SITE, 'cursor-b', inDevelopment)).toBe(inDevelopment);
    expect(withHoneytoken(KEY, SITE, 'cursor-b', [])).toEqual([]);
  });
});
