/**
 * `GET /v2/search/ai` (S12-08, PLAN §8 #3 / §9.1, port of SPW-AI's AI search): a visitor's sentence → structured
 * filters (FAST tier, `ai.structured`) → the site's search, like `/v2/listings`.
 *
 * The one place a request path calls the model (ADR 0008 #9 otherwise keeps AI in workers), so:
 * - **cached by the normalized sentence**, globally: the model sees only the sentence (no site data, no ids), so one
 *   answer serves every site; concepts and place names are resolved per request against the cached taxonomy in
 *   memory (`toFilters`). Single-flight per process (the cache's loader).
 * - **only cache misses reach the model**, and misses are counted (S12-08 review): per API key, per browser
 *   (publishable keys), per site and per agency per month (this feature's share of the agency's AI budget). Past a
 *   limit, or with the limiter unreachable, the request answers with a keyword search and the model is not called.
 *   Suspicious callers and cursor pages read the cache only. With redis-cache down (nowhere to keep the answer), the
 *   model is not called either.
 * - **strict timeout** (`timeoutMs`): past it, the request answers with a keyword search; the model's answer, when it
 *   comes, still lands in the cache for the next visitor — while fewer than `maxLateCalls` such calls run in this
 *   process (beyond it no new model call starts). The gateway's own timeout bounds a late call (feed-api: 3 s, no
 *   retries).
 * - **fallback on any failure** (budget hard cap, outage, open breaker, invalid output, refusal, cache errors):
 *   the sentence is searched as free text (`understood.source = 'KEYWORD'`).
 * - Metering: the call names the site's agency and plan (`ctx.tenant`), so the gateway checks its budget and records
 *   usage through the store the process installed (feed-api: the request-safe store of S12-01, no `withSystem`).
 * - The sentence reaches the model inside an untrusted block (`untrustedBlock`), and the prompt says to treat it as
 *   data.
 */
import type { WebsiteAiSearchFilters, WebsiteAiSearchPage, WebsiteAiSearchQuery } from '@inmolink/contracts';
import { type AiCtx, type AiSettings, ai, costMicroUsd, type PromptRef, untrustedBlock } from '@inmolink/platform/ai';
import { cache, cacheConnection, cacheKey } from '@inmolink/platform/cache';
import { AppError, isAppError } from '@inmolink/platform/errors';
import { createLogger, type Logger } from '@inmolink/platform/logger';
import { type RateLimitCheck, type RateLimiter, rateLimiter } from '@inmolink/platform/rate-limit';
import * as taxonomy from '../taxonomy';
import { aiQueryHash, cleanAnswer, normalizeAiQuery, SearchAiAnswer, toFilters } from './ai-search-parse';
import { type ApiSite, langOf, searchPage } from './service';

export const AI_SEARCH_FEATURE = 'website-api.search-ai';
export const AI_SEARCH_PROMPT: PromptRef = { id: 'search-ai', version: 1 };

/** The model's input for a normalized sentence: the sentence as untrusted data. */
export const aiSearchInput = (normalized: string): string => untrustedBlock('visitor_query', normalized);

/** Turns a normalized sentence into the model's answer. The default asks the gateway; tests inject fakes. */
export interface AiSearchParser {
  parse(ctx: AiCtx, normalizedQuery: string): Promise<SearchAiAnswer>;
}

/** The gateway parser: FAST tier (the prompt file), structured output, no gateway cache (this module caches). */
export const gatewayAiSearchParser: AiSearchParser = {
  async parse(ctx, normalizedQuery) {
    const { data } = await ai.structured(ctx, {
      feature: AI_SEARCH_FEATURE,
      prompt: AI_SEARCH_PROMPT,
      input: aiSearchInput(normalizedQuery),
      schema: SearchAiAnswer,
      cacheKey: false,
    });
    return data;
  },
};

/** Model calls (cache misses) allowed per caller. */
export interface AiSearchLimits {
  /** Per API key, per minute. */
  perKeyPerMinute: number;
  /** Per browser (publishable keys: key × client IP), per minute. */
  perBrowserPerMinute: number;
  /** Per site, per UTC day. */
  perSitePerDay: number;
  /**
   * Per agency, per 30-day window: this feature's share of the agency's AI budget, in calls (feed-api derives it from
   * `SEARCH_AI_BUDGET_SHARE_BP`, the plan's hard cap and the FAST model's price).
   */
  perAgencyPerMonth: (plan: string | null) => number;
}

/** A call's worst case for the monthly share: the system prompt and sentence in, the prompt's `maxTokens` out. */
const CALL_ESTIMATE = { inputTokens: 1_600, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 };

/**
 * `perAgencyPerMonth` from the AI settings (S12-08 review): `shareBp` of the plan's hard cap, in worst-case FAST calls.
 * No price for the FAST model (AI off): 0 calls.
 */
export function aiSearchMonthlyCalls(ai: AiSettings, shareBp: number): (plan: string | null) => number {
  const model = ai.models?.FAST;
  const perCall = model ? costMicroUsd(ai.pricing[model], CALL_ESTIMATE) : 0;
  return (plan) => {
    if (perCall <= 0) return 0;
    const budget = (plan ? ai.budgetsByPlan[plan] : undefined) ?? ai.defaultBudget;
    return Math.floor((budget.hardMicroUsd * shareBp) / 10_000 / perCall);
  };
}

export interface AiSearchSettings {
  parser: AiSearchParser;
  /** How long a request waits for the model before it answers with a keyword search. */
  timeoutMs: number;
  /** How long an understood sentence is kept (Redis). */
  cacheTtlSeconds: number;
  limits: AiSearchLimits;
  /** Model calls still running after their request answered (timed out), per process; beyond it none starts. */
  maxLateCalls: number;
  /** The rate limiter (default: the process's). */
  limiter: () => RateLimiter;
  /** Whether redis-cache can keep an answer now (default: the cache connection is ready). */
  cacheReady: () => boolean;
}

export const DEFAULT_AI_SEARCH_LIMITS: AiSearchLimits = {
  perKeyPerMinute: 120,
  perBrowserPerMinute: 10,
  perSitePerDay: 5_000,
  perAgencyPerMonth: () => 20_000,
};

const DEFAULTS: AiSearchSettings = {
  parser: gatewayAiSearchParser,
  timeoutMs: 500,
  cacheTtlSeconds: 7 * 86_400,
  limits: DEFAULT_AI_SEARCH_LIMITS,
  maxLateCalls: 32,
  limiter: () => rateLimiter(),
  cacheReady: () => {
    try {
      return cacheConnection().status === 'ready';
    } catch {
      return false;
    }
  },
};
let settings: AiSearchSettings = DEFAULTS;

/** Boot (feed-api, from env) and tests. `undefined` restores the defaults. */
export function configureAiSearch(next?: Partial<AiSearchSettings>): void {
  settings = next ? { ...DEFAULTS, ...next, limits: { ...DEFAULTS.limits, ...next.limits } } : DEFAULTS;
  lateCalls = 0;
}

let log: Logger | undefined;
const logger = () => {
  log ??= createLogger({ service: 'website-api' });
  return log;
};

/** The understood-sentence cache key: global (the sentence is the whole model input), per prompt version. */
export const aiSearchCacheKey = (normalized: string) =>
  cacheKey({
    v: 1,
    module: 'website-api',
    entity: 'ai-search',
    scope: 'global',
    id: `${AI_SEARCH_PROMPT.id}.v${AI_SEARCH_PROMPT.version}.${aiQueryHash(normalized)}`,
  });

/** Who is asking (the route's key and client address): what the miss limits count. */
export interface AiSearchCaller {
  keyId: string;
  kind: 'SECRET' | 'PUBLISHABLE';
  /** The client IP bucket (`ipBucket`). */
  ip: string;
}

const MONTH_SECONDS = 30 * 86_400;

function missChecks(site: ApiSite, caller: AiSearchCaller): RateLimitCheck[] {
  const l = settings.limits;
  const checks: RateLimitCheck[] = [
    {
      rule: { name: 'ai-search.key', scope: 'key', limit: l.perKeyPerMinute, windowSeconds: 60, failClosed: true },
      identity: caller.keyId,
    },
    {
      rule: {
        name: 'ai-search.site',
        scope: 'tenant',
        limit: l.perSitePerDay,
        windowSeconds: 86_400,
        fixedWindow: true,
        failClosed: true,
      },
      identity: site.scope.siteId,
    },
    {
      rule: {
        name: 'ai-search.month',
        scope: 'tenant',
        limit: l.perAgencyPerMonth(site.plan),
        windowSeconds: MONTH_SECONDS,
        fixedWindow: true,
        failClosed: true,
      },
      identity: site.scope.agencyId,
      countLast: true,
    },
  ];
  if (caller.kind === 'PUBLISHABLE') {
    checks.push({
      rule: {
        name: 'ai-search.browser',
        scope: 'ip',
        limit: l.perBrowserPerMinute,
        windowSeconds: 60,
        failClosed: true,
      },
      identity: `${caller.keyId}|${caller.ip}`,
    });
  }
  return checks;
}

/** Model calls of this process still running after their request answered. */
let lateCalls = 0;
const counted = new WeakSet<Promise<unknown>>();

const TIMED_OUT = Symbol('ai-search-timeout');

interface UnderstandOptions {
  /** Read the cache only: suspicious callers and cursor pages never reach the model. */
  cacheOnly: boolean;
  caller: AiSearchCaller | null;
}

/** The clean answer for the sentence, or null (miss in cache-only mode, a limit, timeout, any failure). */
async function understand(site: ApiSite, normalized: string, opts: UnderstandOptions): Promise<SearchAiAnswer | null> {
  const ctx: AiCtx = { tenant: { agencyId: site.scope.agencyId, plan: site.plan }, requestId: site.requestId };
  const started = Date.now();
  const load = async (): Promise<SearchAiAnswer | undefined> => {
    // `undefined` is never cached: the next request (or the next page's) asks again.
    if (opts.cacheOnly || opts.caller === null) return undefined;
    if (!settings.cacheReady()) throw new AppError('AI_UNAVAILABLE', { reason: 'CACHE_DOWN' });
    if (lateCalls >= settings.maxLateCalls) throw new AppError('AI_UNAVAILABLE', { reason: 'LATE_CALLS' });
    const checks = missChecks(site, opts.caller);
    const results = await settings.limiter().consumeMany(checks);
    const denied = results.findIndex((r) => !r.allowed);
    if (denied >= 0) throw new AppError('AI_UNAVAILABLE', { reason: 'RATE_LIMITED', rule: checks[denied]?.rule.name });
    return cleanAnswer(await settings.parser.parse(ctx, normalized), normalized);
  };
  let pending: Promise<SearchAiAnswer | undefined>;
  try {
    pending = cache.get(aiSearchCacheKey(normalized), { ttlSeconds: settings.cacheTtlSeconds }, load);
  } catch (err) {
    pending = Promise.reject(err);
  }
  // A late answer still fills the cache; its failure is logged below or dropped after a timeout.
  pending.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), settings.timeoutMs);
    timer.unref?.();
  });
  try {
    const out = await Promise.race([pending, timeout]);
    if (out === TIMED_OUT) {
      if (!counted.has(pending)) {
        counted.add(pending);
        lateCalls++;
        pending.finally(() => lateCalls--).catch(() => undefined);
      }
      logger().warn(
        { agencyId: site.scope.agencyId, ms: settings.timeoutMs, lateCalls },
        'ai search timed out: keyword search',
      );
      return null;
    }
    return out ?? null;
  } catch (err) {
    const code = isAppError(err) ? err.code : 'UNEXPECTED';
    const details = isAppError(err) ? (err.details as { reason?: string; rule?: string } | undefined) : undefined;
    logger().warn(
      {
        agencyId: site.scope.agencyId,
        code,
        reason: details?.reason,
        rule: details?.rule,
        ms: Date.now() - started,
        ...(code === 'UNEXPECTED' ? { err } : {}),
      },
      'ai search failed: keyword search',
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Tests: model calls of this process still running after their request answered. */
export const aiSearchLateCalls = (): number => lateCalls;

/** The free text a keyword search takes (the listings search's limit). */
const KEYWORD_MAX = 100;

/**
 * `GET /v2/search/ai`: the sentence understood as filters, then the site's search (its inventory, white-labelled
 * cards, cursors) — the same reads as `/v2/listings`. Warm: one Redis read for the sentence, no extra statement.
 * Without a `caller` (no key) or for a suspicious caller or a cursor page, the cache only.
 */
export async function aiSearch(
  site: ApiSite,
  q: WebsiteAiSearchQuery,
  opts: { suspicious?: boolean; caller?: AiSearchCaller } = {},
): Promise<WebsiteAiSearchPage> {
  const lang = langOf(site, q.lang);
  const normalized = normalizeAiQuery(q.q);
  const answer =
    normalized === ''
      ? null
      : await understand(site, normalized, {
          cacheOnly: opts.suspicious === true || q.cursor !== undefined,
          caller: opts.caller ?? null,
        });
  let filters: WebsiteAiSearchFilters | null = null;
  let unmatched: string[] = [];
  if (answer) {
    const resolved = toFilters(answer, await taxonomy.searchVocabulary(lang));
    if (!resolved.empty) {
      filters = resolved.query;
      unmatched = resolved.unmatched;
    }
  }
  const source = filters ? 'AI' : 'KEYWORD';
  filters ??= { q: q.q.trim().replace(/\s+/g, ' ').slice(0, KEYWORD_MAX).trim() };
  const { page } = await searchPage(
    site,
    { ...filters, sort: filters.sort ?? 'newest', lang, limit: q.limit, cursor: q.cursor, facets: q.facets },
    { suspicious: opts.suspicious },
  );
  return { ...page, understood: { source, filters, unmatched } };
}
