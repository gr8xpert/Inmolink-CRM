/**
 * Network search (S5-05, PLAN §3 #5 #7 #57, §7 M10): an agency's agents search the other agencies' listings and
 * new-build units shared with them, with the commission terms upfront.
 *
 * - **Give-to-get:** only an agency with `minShared` ACTIVE listings on the network searches it — or a new one within
 *   its grace period, or one staff exempted (buyer-only). Anyone else gets the upsell state (LOCKED), not results.
 * - **Who sees what:** the engine filter mirrors the network policy — SHARED and PUBLIC listings shared with ALL, or
 *   PREFERRED by an owner that prefers the caller (S6-F2: their documents name the agencies the owner prefers, so the
 *   filter names only the caller, however many owners prefer it), and not hidden for freshness (`networkHidden`);
 *   units of OPEN developments or of the PRIVATE_NETWORK ones shared with the caller (their documents name the
 *   allowed agencies); never the caller's own, never PRIVATE (those have no index document). The engine only finds
 *   ids: every result is then read under the caller's RLS (terms and card), so a document the index still holds but
 *   the caller may no longer read (just made PREFERRED, unshared, hidden for freshness, an owner suspended or unlisted)
 *   is left out of the page. So the total is approximate (S6-F1): the engine's estimate of matching documents, which
 *   counts those too — a page can be short, and the total can exceed what paging reaches. Freshness-hidden listings are
 *   left out by the engine itself (S6-F2), so they never shorten a page or count.
 * - **Commission:** the total, the split and the caller's own earnings, from the listing's or unit's own values.
 *
 * Three steps, the engine outside any transaction (CLAUDE.md rule 6): the caller's standing and partners (two
 * statements), the engine query, then hydration (cards, listing terms, unit terms, owner names) — with each
 * transaction's member check, at most ten statements a page.
 */
import {
  type GiveToGetGate,
  type NetworkCommission,
  NetworkSearchBody,
  type NetworkSearchItem,
  type NetworkSearchResult,
} from '@inmolink/contracts';
import { CONTENT_LOCALES, FALLBACK_CONTENT_LOCALE } from '@inmolink/i18n';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { createLogger, type Logger } from '@inmolink/platform/logger';
import { type Filter, type SearchEngine, SearchError, searchEngine } from '@inmolink/platform/search';
import type { Ctx, CtxRunner } from '../../context';
import * as agencies from '../agencies';
import * as developments from '../developments';
import * as properties from '../properties';
import { attributeFilters } from './filters';
import { listingsIndex } from './index-doc';
import { listingsIndexUid } from './indexer';
import { assertCan } from './policy';
import * as repo from './repo';
import { SEARCH_RESULT_CAP } from './website';

/** Give-to-get defaults (PLAN §3 #5); apps set them from config (`networkEnv`) at boot. */
export const GIVE_TO_GET_DEFAULTS = { minShared: 5, graceDays: 30 } as const;
/** Longest wait for the engine: a dashboard search fails clearly rather than hanging. */
export const NETWORK_ENGINE_TIMEOUT_MS = 1_000;

let giveToGet: { minShared: number; graceDays: number } = { ...GIVE_TO_GET_DEFAULTS };

/** Boot: the give-to-get threshold and grace period from config (`NETWORK_GIVE_TO_GET_*`). */
export function configureNetworkSearch(options: { giveToGetMinShared?: number; giveToGetGraceDays?: number }): void {
  giveToGet = {
    minShared: options.giveToGetMinShared ?? GIVE_TO_GET_DEFAULTS.minShared,
    graceDays: options.giveToGetGraceDays ?? GIVE_TO_GET_DEFAULTS.graceDays,
  };
}

let log: Logger | undefined;
const logger = () => {
  log ??= createLogger({ service: 'search' });
  return log;
};

/** The gate from the agency's standing: exempt, enough shared, within grace, or locked. */
export function giveToGetGate(input: {
  exempt: boolean;
  sharedListings: number;
  createdAt: Date;
  now: Date;
  minShared: number;
  graceDays: number;
}): GiveToGetGate {
  const graceEndsAt = new Date(input.createdAt.getTime() + input.graceDays * 86_400_000);
  const state = input.exempt
    ? 'EXEMPT'
    : input.sharedListings >= input.minShared
      ? 'OPEN'
      : input.now < graceEndsAt
        ? 'GRACE'
        : 'LOCKED';
  return {
    state,
    sharedListings: input.sharedListings,
    threshold: input.minShared,
    graceEndsAt: graceEndsAt.toISOString(),
  };
}

/** One listing's or unit's terms, as the commission maths needs them. */
export interface CommissionTerms {
  priceCents: number | null;
  priceOnRequest: boolean;
  currency: string;
  commissionBp: number | null;
  commissionFixedCents: number | null;
  /** The fixed amount's currency. */
  commissionCurrency: string;
  /** The collaborating agent's share; null when the listing names none. */
  splitBp: number | null;
  includesVat: boolean;
}

/**
 * The commission a result shows (PLAN §3 #7): total, split and the caller's earnings — price × total × split (both in
 * basis points), or the fixed amount × split, rounded down to the cent; null when there is no price (on request) or
 * no split. Exact integer maths (bigint): price × 10⁴ × 10⁴ exceeds a double's exact range.
 */
export function networkCommission(t: CommissionTerms): NetworkCommission | null {
  const split = t.splitBp;
  if (t.commissionBp !== null) {
    const price = t.priceOnRequest ? null : t.priceCents;
    return {
      type: 'PCT',
      totalBp: t.commissionBp,
      fixed: null,
      splitBp: split,
      includesVat: t.includesVat,
      viewerEarnings:
        price === null || split === null
          ? null
          : {
              amountCents: Number((BigInt(price) * BigInt(t.commissionBp) * BigInt(split)) / 100_000_000n),
              currency: t.currency,
            },
    };
  }
  if (t.commissionFixedCents !== null) {
    return {
      type: 'FIXED',
      totalBp: null,
      fixed: { amountCents: t.commissionFixedCents, currency: t.commissionCurrency },
      splitBp: split,
      includesVat: t.includesVat,
      viewerEarnings:
        split === null
          ? null
          : {
              amountCents: Number((BigInt(t.commissionFixedCents) * BigInt(split)) / 10_000n),
              currency: t.commissionCurrency,
            },
    };
  }
  return null;
}

/** A developer pays a unit's commission to the selling agency whole: there is no listing agent to split with. */
const UNIT_SPLIT_BP = 10_000;

type Parsed = ReturnType<typeof NetworkSearchBody.parse>;

/** Who the caller is on the network: its own agency and its preferred list. */
interface Scope {
  self: string;
  preferred: string[];
}

/** Step 1's answer: the gate, and — unless it is LOCKED — what the engine query needs. */
type Standing =
  | { gate: GiveToGetGate; scope: null }
  | { gate: GiveToGetGate; scope: Scope; locale: string; requestId: string };

const SORTS = {
  newest: { field: 'publishedAt', dir: 'desc' },
  price_asc: { field: 'priceCents', dir: 'asc' },
  price_desc: { field: 'priceCents', dir: 'desc' },
  beds_desc: { field: 'beds', dir: 'desc' },
  area_desc: { field: 'areaM2', dir: 'desc' },
} as const satisfies Record<Parsed['sort'], { field: string; dir: 'asc' | 'desc' }>;

/** The documents the caller may see (the network policy as an engine filter) and its query's attributes. */
export function networkFilter(scope: Scope, q: Parsed): Filter {
  const visible: Filter = {
    op: 'or',
    filters: [
      {
        op: 'and',
        filters: [
          { op: 'eq', field: 'kind', value: 'LISTING' },
          { op: 'in', field: 'visibility', values: ['PUBLIC', 'SHARED'] },
          // PREFERRED: the owner prefers the caller (its document names the agencies it prefers).
          {
            op: 'or',
            filters: [
              { op: 'eq', field: 'shareScope', value: 'ALL' },
              { op: 'eq', field: 'preferredAgencyIds', value: scope.self },
            ],
          },
        ],
      },
      {
        op: 'and',
        filters: [
          { op: 'eq', field: 'kind', value: 'UNIT' },
          // OPEN developments' units, or those of the PRIVATE_NETWORK developments shared with the caller
          {
            op: 'or',
            filters: [
              { op: 'eq', field: 'visibility', value: 'PUBLIC' },
              { op: 'eq', field: 'allowedAgencyIds', value: scope.self },
            ],
          },
        ],
      },
    ],
  };
  const filters: Filter[] = [
    visible,
    { op: 'not', filter: { op: 'eq', field: 'ownerAgencyId', value: scope.self } },
    // Not `networkHidden = false`: a document indexed before the field existed has none and is not hidden.
    { op: 'not', filter: { op: 'eq', field: 'networkHidden', value: true } },
    { op: 'in', field: 'status', values: q.statuses },
  ];
  if (q.preferredOnly) filters.push({ op: 'in', field: 'ownerAgencyId', values: scope.preferred });
  filters.push(...attributeFilters({ ...q, kind: q.newBuilds ? 'UNIT' : q.kind }));
  return { op: 'and', filters };
}

const encode = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');

function decode(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const o = (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown }).o;
    if (Number.isInteger(o) && (o as number) > 0 && (o as number) < SEARCH_RESULT_CAP) return o as number;
  } catch {
    // falls through to the error below
  }
  throw new AppError('VALIDATION_FAILED', { field: 'cursor' });
}

/** The caller's locale for text and cards when it is a content locale, else the fallback content locale. */
const contentLocaleOf = (locale: string) =>
  (CONTENT_LOCALES as readonly string[]).includes(locale) ? locale : FALLBACK_CONTENT_LOCALE;

/** `POST /v1/network/search`: the give-to-get gate, then one page of network results with commission terms. */
export async function searchNetwork(
  run: CtxRunner,
  input: NetworkSearchBody,
  options: { engine?: SearchEngine } = {},
): Promise<NetworkSearchResult> {
  const q = NetworkSearchBody.parse(input);
  const offset = decode(q.cursor);

  // 1 · The caller's standing and partners (short read).
  const standing = await run(async (ctx): Promise<Standing> => {
    assertCan(ctx, 'search.network');
    agencies.assertVerified(ctx, 'network.search');
    const { minShared, graceDays } = giveToGet;
    const agency = await agencies.getNetworkStanding(ctx);
    const sharedListings = await properties.countNetworkSharedListings(ctx, Math.max(minShared, 1));
    const gate = giveToGetGate({
      exempt: agency.giveToGetExempt,
      sharedListings,
      createdAt: agency.createdAt,
      now: clock.now(),
      minShared,
      graceDays,
    });
    if (gate.state === 'LOCKED') return { gate, scope: null };
    const scope: Scope = { self: ctx.tenant.agencyId, preferred: agency.preferred };
    return { gate, scope, locale: contentLocaleOf(ctx.locale), requestId: ctx.requestId };
  });
  if (standing.scope === null) return { status: 'LOCKED', gate: standing.gate };
  const { gate, scope, locale } = standing;
  const empty: NetworkSearchResult = { status: 'OK', gate, items: [], total: 0, nextCursor: null };
  if (q.preferredOnly && scope.preferred.length === 0) return empty;

  // 2 · The engine: ids of the documents the caller may see, outside any transaction.
  const def = listingsIndex(listingsIndexUid());
  const searchOn = ['ref', `title_${locale}`, `place_${locale}`, `description_${locale}`].filter((f) =>
    def.searchable.includes(f),
  );
  const limit = Math.min(q.limit, SEARCH_RESULT_CAP - offset);
  let answer: Awaited<ReturnType<SearchEngine['search']>>;
  try {
    answer = await (options.engine ?? searchEngine()).search(def, {
      text: q.text,
      searchOn,
      locale,
      filter: networkFilter(scope, q),
      sort: [SORTS[q.sort]],
      limit,
      offset,
      timeoutMs: NETWORK_ENGINE_TIMEOUT_MS,
    });
  } catch (err) {
    // Code and status only: an adapter error may carry the request body (the agent's text).
    logger().warn(
      {
        requestId: standing.requestId,
        error: err instanceof Error ? err.name : typeof err,
        ...(err instanceof SearchError ? { code: err.code, status: err.status } : {}),
      },
      'network search: engine query failed',
    );
    throw new AppError('SERVICE_UNAVAILABLE', { service: 'search' });
  }
  if (answer.ids.length === 0) return { ...empty, total: Math.min(answer.total, SEARCH_RESULT_CAP) };

  // 3 · Hydration under the caller's RLS: what it may no longer read is left out.
  const items = await run((ctx) => hydrate(ctx, answer.ids, scope, locale));
  const total = Math.min(answer.total, SEARCH_RESULT_CAP);
  const next = offset + answer.ids.length;
  return {
    status: 'OK',
    gate,
    items,
    total,
    nextCursor: answer.ids.length === limit && next < total ? encode(next) : null,
  };
}

async function hydrate(ctx: Ctx, ids: string[], scope: Scope, locale: string): Promise<NetworkSearchItem[]> {
  assertCan(ctx, 'search.network');
  const cards = await repo.networkCards(ctx.tx, ids, locale, FALLBACK_CONTENT_LOCALE);
  const listingIds = cards.filter((c) => c.kind === 'LISTING').map((c) => c.targetId);
  const unitIds = cards.filter((c) => c.kind === 'UNIT').map((c) => c.targetId);
  const listingTerms = await properties.networkListingTerms(ctx, listingIds);
  const unitTerms = await developments.networkUnitTerms(ctx, unitIds);
  const terms = new Map<string, { agencyId: string; commission: NetworkCommission | null }>();
  for (const t of listingTerms) {
    terms.set(t.id, {
      agencyId: t.agencyId,
      commission: networkCommission({
        priceCents: t.priceCents,
        priceOnRequest: t.priceOnRequest,
        currency: t.currency,
        commissionBp: t.commissionBp,
        commissionFixedCents: t.commissionFixedCents,
        commissionCurrency: t.currency,
        splitBp: t.splitBp,
        includesVat: t.commissionIncludesVat,
      }),
    });
  }
  for (const t of unitTerms) {
    terms.set(t.id, {
      agencyId: t.agencyId,
      commission: networkCommission({
        priceCents: t.priceCents,
        priceOnRequest: t.priceCents === null,
        currency: t.currency,
        commissionBp: t.commissionBp,
        commissionFixedCents: t.commissionFixedCents,
        commissionCurrency: t.commissionCurrency,
        splitBp: UNIT_SPLIT_BP,
        includesVat: t.commissionIncludesVat,
      }),
    });
  }
  const names = await agencies.networkAgencyNames(
    ctx,
    [...terms.values()].map((t) => t.agencyId),
  );
  const byId = new Map(cards.map((c) => [c.targetId, c]));
  const preferred = new Set(scope.preferred);
  const items: NetworkSearchItem[] = [];
  // Engine order; a result needs its card, its terms (both read under RLS) and its owner in the directory.
  for (const id of ids) {
    const card = byId.get(id);
    const t = terms.get(id);
    const name = t ? names.get(t.agencyId) : undefined;
    if (!card || !t || name === undefined) continue;
    items.push({
      id,
      kind: card.kind,
      card: card.card as NetworkSearchItem['card'],
      ownerAgency: { id: t.agencyId, name },
      preferred: preferred.has(t.agencyId),
      commission: t.commission,
    });
  }
  return items;
}
