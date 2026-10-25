/**
 * Website API v2 reads (S7-03, PLAN §9.1, ADR 0012): the site-facing use cases feed-api routes call — search, a
 * reference's detail, the delta feed and the sitemap. The composition point of `websites` (site scope, serializer),
 * `search` (inventory, read models, change log), `properties` (the site agency's overrides) and `agencies` (owner
 * identities for the white-label sanitizer): `websites` cannot import `search` or `properties` (identity → websites
 * cycle), so the hydration lives here, not in a route.
 *
 * Every read runs as `app_public` (`withPublicRead`), never in a tenant session. The inventory is the site's policy
 * (`websites.siteSearchScope`), with network listings dropped while the agency's give-to-get standing is locked
 * (S7-01 Decision 2). Query budget per request with the site scope and network gate cached (Redis + 15 s local; a
 * miss costs 2 + 1 statements once a minute per site): search 1–2 statements (+1 when the Postgres fallback answers),
 * detail 1–2, changes 2 (3 from `since`), sitemap 1–2. Overrides and owner identities are one statement.
 *
 * Developments (S7-F6): `/v2/developments`, `/{ref}` and `/{ref}/units` read the development rows
 * (`listing_search_developments`, precomputed aggregates) and units' fallback rows with their read models in one
 * statement each, plus the overrides and owner identities when another agency's development is on the page: 1–2.
 */
import type {
  ListingCardDoc,
  ListingDetailDoc,
  PublicListingSearch,
  UnitCardDoc,
  UnitDetailDoc,
  WebsiteChangesPage,
  WebsiteChangesQuery,
  WebsiteDetail,
  WebsiteDevelopmentDetail,
  WebsiteDevelopmentPage,
  WebsiteDevelopmentsQuery,
  WebsiteListingPage,
  WebsiteListingsQuery,
  WebsiteSitemapPage,
  WebsiteSitemapQuery,
  WebsiteUnitPage,
  WebsiteUnitsQuery,
} from '@inmolink/contracts';
import { PublicCode } from '@inmolink/contracts';
import { type Tx, withPublicRead } from '@inmolink/db';
import { LocalLru } from '@inmolink/platform/cache';
import { clock } from '@inmolink/platform/clock';
import { hmacSha256, safeEqual } from '@inmolink/platform/crypto';
import { AppError } from '@inmolink/platform/errors';
import { type SQL, sql } from 'drizzle-orm';
import { compileOwner, NO_OWNER, type OwnerIdentity, type OwnerMatcher } from '../../white-label';
import { readAiRemovals } from '../../white-label-store';
import * as agencies from '../agencies';
import * as properties from '../properties';
import * as search from '../search';
import * as websites from '../websites';
import { raiseWebsiteAlert } from './alerts';
import { unwrapSearchCursor, wrapSearchCursor } from './cursor';
import { type EdgeSeen, newEdgeSeen } from './edge';
import { honeytokenKind, withHoneytoken } from './honeytokens';
import { configured, cursorSecret, websiteLimits } from './settings';

/** A site as one request serves it. */
export interface ApiSite {
  /** The calling key (alerts name it). */
  keyId: string | null;
  scope: websites.SiteScope;
  /**
   * The site's inventory (`search.PublicSearchSite`); null: the site shows nothing now (a network-only CUSTOM site of
   * an agency whose give-to-get standing is locked).
   */
  inventory: websites.SiteSearchScope | null;
  /**
   * A short keyed hash (HMAC, `HMAC_KEY`) of the effective inventory rules: `/v2/changes` reports it (`scope`) so a
   * plugin can resync.
   */
  tag: string;
  requestId: string;
  /**
   * S12-08: the site agency's plan (AI budgets per plan). Plans arrive with billing (S13): until then `'none'` for
   * every agency, as in a member's ctx.
   */
  plan: string | null;
  /** What this request's answer showed (S7-06): its edge cache tags (`edgeTagsOf`). */
  edge: EdgeSeen;
}

/**
 * The site a website API key serves (S7-01: keys are bound to a site). Keys created before sites existed have none
 * and are refused (`API_KEY_SITE_REQUIRED`). Network listings are dropped while the agency's give-to-get standing is
 * locked (`search.websiteNetworkOpen`, cached). Cached reads only on a warm path: no statement.
 */
export async function siteForKey(
  key: { keyId?: string; agencyId: string; siteId: string | null },
  requestId: string,
): Promise<ApiSite> {
  if (key.siteId === null) throw new AppError('API_KEY_SITE_REQUIRED');
  const scope = await websites.siteScope(key.siteId);
  // The key's site is its agency's (composite foreign key); anything else is refused, never served.
  if (scope.agencyId !== key.agencyId) throw new AppError('SITE_NOT_FOUND');
  return apiSiteOf(scope, key.keyId ?? null, requestId);
}

const SITE_TAG_PURPOSE = 'website-api.site-tag';

/**
 * A site's scope as one request serves it (website API keys, S7-F8 embed pages): its inventory with network listings
 * dropped while the agency's give-to-get standing is locked. Cached reads only on a warm path.
 */
export async function apiSiteOf(scope: websites.SiteScope, keyId: string | null, requestId: string): Promise<ApiSite> {
  let inventory: websites.SiteSearchScope = websites.siteSearchScope(scope, requestId);
  if (inventory.networkOf !== undefined && !(await search.websiteNetworkOpen(scope.agencyId))) {
    const { networkOf: _network, networkRefPrefix: _prefix, ...own } = inventory;
    inventory = own;
  }
  // S8-F4: an HMAC, not a plain hash — the rules include the minimum commission, which a visitor could otherwise
  // brute-force from `/v2/changes`' `scope` (few candidate values, the rest of the rules guessable).
  const tag = hmacSha256(
    cursorSecret(),
    SITE_TAG_PURPOSE,
    JSON.stringify([
      inventory.ownerAgencyIds,
      inventory.networkOf ?? null,
      inventory.networkRefPrefix ?? null,
      inventory.restrict ?? null,
    ]),
  ).slice(0, 16);
  const shows = inventory.ownerAgencyIds.length > 0 || inventory.networkOf !== undefined;
  // S12-08: plans arrive with billing (S13); every agency is on the same footing until then (like `withMemberCtx`).
  return { keyId, scope, inventory: shows ? inventory : null, tag, requestId, plan: 'none', edge: newEdgeSeen() };
}

/** `?lang=`: one of the site's languages (default its first). */
export function langOf(site: ApiSite, lang: string | undefined): string {
  const chosen = lang ?? site.scope.defaultLocale;
  if (!site.scope.locales.includes(chosen)) {
    throw new AppError('VALIDATION_FAILED', { field: 'lang', reason: 'not a language of this site' });
  }
  return chosen;
}

// ── Owner identities (white-label sanitizer) ────────────────────────────────────────────────────────────────────

/** Compiled matchers by identity content (not by owner): an edited identity is a new key, never a stale matcher. */
const ownerMatchers = new LocalLru<OwnerMatcher>(5_000);
const MATCHER_TTL_MS = 10 * 60_000;

/** Tests: forget compiled owner identities. */
export function resetWebsiteApiCaches(): void {
  ownerMatchers.clear();
}

function matcherOf(identity: OwnerIdentity): OwnerMatcher {
  const key = JSON.stringify(identity);
  const hit = ownerMatchers.get(key);
  if (hit) return hit;
  const matcher = compileOwner(identity);
  ownerMatchers.set(key, matcher, MATCHER_TTL_MS);
  return matcher;
}

type Doc = ListingCardDoc | UnitCardDoc | ListingDetailDoc | UnitDetailDoc;

/**
 * How this site presents these documents: its presenter and media base, and — only when some are other agencies' —
 * the site agency's overrides and the owners' identities, read together in one statement (each module builds its
 * own part, `properties.siteOverridesQuery` / `agencies.ownerIdentitiesQuery`) and compiled once per identity.
 */
async function viewFor(
  tx: Tx,
  site: ApiSite,
  lang: string,
  rows: readonly Pick<search.PublicDocRow, 'targetId' | 'ownerAgencyId' | 'doc'>[],
): Promise<websites.SiteView> {
  return (await viewWith(tx, site, lang, rows)).view;
}

/**
 * `viewFor`, plus one more subquery of the caller's (S8-02: the v1 shim's legacy ids of the page) in the same
 * statement: its value is `extra`. With an extra part the statement always runs (one statement either way).
 */
export async function viewWith(
  tx: Tx,
  site: ApiSite,
  lang: string,
  rows: readonly Pick<search.PublicDocRow, 'targetId' | 'ownerAgencyId' | 'doc'>[],
  extra?: SQL,
): Promise<{ view: websites.SiteView; extra: unknown }> {
  const view: websites.SiteView = {
    site: { agencyId: site.scope.agencyId, referencePrefix: site.scope.referencePrefix },
    presenter: site.scope.presenter,
    mediaBaseUrl: configured().mediaBaseUrl,
  };
  const network = rows.filter((r) => r.ownerAgencyId !== site.scope.agencyId);
  if (network.length === 0) {
    if (extra === undefined) return { view, extra: undefined };
    const res = await tx.execute(sql`select ${extra} as extra`);
    return { view, extra: (res.rows[0] as { extra: unknown }).extra };
  }
  const targets = network.flatMap((r) => {
    const doc = r.doc as Doc;
    return doc.kind === 'UNIT' ? [r.targetId, doc.development.id] : [r.targetId];
  });
  const overrides = properties.siteOverridesQuery(site.scope.agencyId, targets, lang);
  const owners = agencies.ownerIdentitiesQuery(network.map((r) => r.ownerAgencyId));
  // S12-03: the model pass's cached removals of the network texts (one MGET on redis-cache, alongside the statement).
  const [res, aiRemovals] = await Promise.all([
    tx.execute(
      sql`select ${overrides.sql} as overrides, ${owners.sql} as owners${extra === undefined ? sql`` : sql`, ${extra} as extra`}`,
    ),
    readAiRemovals(network.map((r) => ({ agencyId: r.ownerAgencyId, targetId: r.targetId }))),
  ]);
  const row = res.rows[0] as { overrides: unknown; owners: unknown; extra?: unknown };
  const identities = owners.read(row.owners);
  const matchers = new Map<string, OwnerMatcher>();
  for (const id of new Set(network.map((r) => r.ownerAgencyId))) {
    matchers.set(id, matcherOf(identities.get(id) ?? NO_OWNER));
  }
  return { view: { ...view, overrides: overrides.read(row.overrides), matchers, aiRemovals }, extra: row.extra };
}

export const owned = <D>(r: search.PublicDocRow) => ({
  ownerAgencyId: r.ownerAgencyId,
  publicCode: r.publicCode,
  developmentCode: r.developmentCode,
  developmentOwnRef: r.developmentOwnRef,
  doc: r.doc as D,
});

/** The site as the serializer names it (references, prefixes). */
const shownSite = (site: ApiSite) => ({ agencyId: site.scope.agencyId, referencePrefix: site.scope.referencePrefix });

// ── Search ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `GET /v2/listings`: one page of the site's inventory matching a visitor's filters, as the site shows it. A caller
 * `suspicious` of scripted paging (`checkWebsiteLimits`) may find a honeytoken on a deep page (`withHoneytoken`).
 */
export async function searchListings(
  site: ApiSite,
  q: WebsiteListingsQuery,
  opts: { suspicious?: boolean } = {},
): Promise<WebsiteListingPage> {
  return (await searchPage(site, q, opts)).page;
}

/** A search page with what the v1 shim reshapes it from (S8-02). */
export interface SearchPage {
  page: WebsiteListingPage;
  /** The value of the caller's `extra` subquery (undefined without one or on an empty page). */
  extra: unknown;
  /** The raw target id of each real card, by the card's (site-scoped) id; honeytokens have none. */
  targetOf: ReadonlyMap<string, string>;
}

/**
 * `searchListings`, with one more subquery of the caller's in the page's presentation statement (`viewWith`): `extra`
 * is built from the page's public documents.
 */
export async function searchPage(
  site: ApiSite,
  q: WebsiteListingsQuery,
  opts: {
    suspicious?: boolean;
    extra?: (rows: readonly search.PublicDocRow[]) => SQL;
    /**
     * S8-02: when the Postgres fallback restarted an engine cursor at its first page (`resultsChanged`), answer no item
     * (the total only) and read no document — the v1 shim's numbered pages cannot continue in the fallback.
     */
    dropRestarted?: boolean;
  } = {},
): Promise<SearchPage> {
  const lang = langOf(site, q.lang);
  const from = q.cursor === undefined ? undefined : unwrapSearchCursor(site.scope.siteId, q.cursor);
  const depth = from?.depth ?? 0;
  const targetOf = new Map<string, string>();
  const empty = { items: [], total: 0, facets: {}, nextCursor: null, degraded: false };
  if (!site.inventory) return { page: empty, extra: undefined, targetOf };
  const input: PublicListingSearch = {
    text: q.q,
    locale: lang,
    kind: q.kind,
    developmentId: q.developmentId,
    // A development by the reference the site shows (S7-F6): an own one's own reference, a network one's code.
    developmentRef: q.development,
    ...(q.status ? { statuses: q.status } : {}),
    transactionType: q.transaction,
    propertyTypeIds: q.types,
    locationIds: q.locations,
    featureIds: q.features,
    priceMinCents: q.priceMin,
    priceMaxCents: q.priceMax,
    bedsMin: q.bedsMin,
    bathsMin: q.bathsMin,
    areaMinM2: q.areaMin,
    areaMaxM2: q.areaMax,
    geoBox: q.bbox ? { north: q.bbox[0], west: q.bbox[1], south: q.bbox[2], east: q.bbox[3] } : undefined,
    facets: q.facets ?? [],
    sort: q.sort,
    limit: q.limit,
    cursor: from?.inner,
  };
  const found = await search.searchPublicListings(site.inventory, input);
  if (opts.dropRestarted && found.resultsChanged) {
    const page: WebsiteListingPage = { ...empty, total: found.total, degraded: found.backend === 'fallback' };
    return { page: { ...page, resultsChanged: true }, extra: undefined, targetOf };
  }
  let extra: unknown;
  const cards =
    found.ids.length === 0
      ? []
      : await withPublicRead(async (tx) => {
          const rows = await search.publicDocs(tx, found.ids, 'card', lang, site.scope.defaultLocale);
          const byId = new Map(rows.map((r) => [r.targetId, r]));
          // The engine's order; a target whose read model went in between is left out.
          const ordered = found.ids.flatMap((id) => byId.get(id) ?? []);
          for (const r of ordered) site.edge.targets.add(r.targetId);
          const shown = await viewWith(tx, site, lang, ordered, opts.extra?.(ordered));
          extra = shown.extra;
          const serialized = websites.serializeCards(shown.view, ordered.map(owned<ListingCardDoc | UnitCardDoc>));
          // Cards keep the documents' order; only R2 dedupe (`canonicalOf`) could drop one — then no card is named.
          if (serialized.length === ordered.length) {
            for (const [i, card] of serialized.entries()) {
              targetOf.set(card.id, (ordered[i] as search.PublicDocRow).targetId);
            }
          }
          return serialized;
        });
  const limits = websiteLimits();
  const items =
    limits.honeytokens && opts.suspicious === true && q.cursor !== undefined && depth >= limits.honeytokenMinPage
      ? withHoneytoken(cursorSecret(), site.scope, q.cursor, cards)
      : cards;
  const page: WebsiteListingPage = {
    items,
    total: found.total,
    facets: found.facets,
    nextCursor: found.nextCursor === null ? null : wrapSearchCursor(site.scope.siteId, depth + 1, found.nextCursor),
    degraded: found.backend === 'fallback',
    ...(found.resultsChanged ? { resultsChanged: true as const } : {}),
  };
  return { page, extra, targetOf };
}

/**
 * A reference this site has no listing for. One of its honeytokens (only a full-inventory scrape found it) raises
 * `WebsiteHoneytokenHit`; the answer is the same 404 as for a withdrawn listing. A code-style hit is confirmed to be no
 * real public code first (its check part is 20 bits) — one more statement on this 404 path only.
 */
export async function listingNotFound(tx: Tx, site: ApiSite, ref: string): Promise<AppError> {
  const token = honeytokenKind(cursorSecret(), site.scope, ref);
  if (token && !(token.style === 'code' && (await search.publicCodeInUse(tx, token.code)))) {
    raiseWebsiteAlert({
      kind: 'honeytoken',
      ref,
      siteId: site.scope.siteId,
      agencyId: site.scope.agencyId,
      keyId: site.keyId,
      requestId: site.requestId,
    });
  }
  return new AppError('LISTING_NOT_FOUND');
}

/** `GET /v2/listings/{ref}`: the detail a reference names on this site (own reference, or `<prefix>-<code>`). */
export async function listingDetail(site: ApiSite, ref: string, lang?: string): Promise<WebsiteDetail> {
  const locale = langOf(site, lang);
  const inventory = site.inventory;
  if (!inventory) throw await withPublicRead((tx) => listingNotFound(tx, site, ref));
  return search.withSiteRead(inventory, async (tx) => {
    const row = await search.publicDetailByRef(tx, inventory, ref, locale, site.scope.defaultLocale);
    if (!row) throw await listingNotFound(tx, site, ref);
    site.edge.targets.add(row.targetId);
    const view = await viewFor(tx, site, locale, [row]);
    return websites.serializeDetail(view, owned<ListingDetailDoc | UnitDetailDoc>(row));
  });
}

/**
 * S7-07: the details of these documents as the site shows them in `lang` — the XML feed's items, white-labelled and
 * overridden exactly like `/v2/listings/{ref}` — and whether the site agency overrides each one's text in `lang`. One
 * statement when other agencies' documents are among them.
 */
export async function serializeDetailsFor(
  tx: Tx,
  site: ApiSite,
  lang: string,
  rows: readonly search.PublicDocRow[],
): Promise<{ row: search.PublicDocRow; detail: WebsiteDetail; overridden: boolean }[]> {
  const view = await viewFor(tx, site, lang, rows);
  const overrides = view.overrides?.targets;
  return rows.map((r) => ({
    row: r,
    detail: websites.serializeDetail(view, owned<ListingDetailDoc | UnitDetailDoc>(r)),
    overridden: overrides?.has(r.targetId) ?? false,
  }));
}

// ── Delta feed ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A changes cursor: the log position (`x` xid8, `s` seq) and the hour it was handed out (`h`, epoch hours). */
interface ChangesCursor {
  x: string;
  s: number;
  h: number;
}

const CURSOR_PURPOSE = 'website-api.changes-cursor';
const encodeCursor = (c: unknown) => Buffer.from(JSON.stringify(c)).toString('base64url');

const macOf = (c: ChangesCursor) => hmacSha256(cursorSecret(), CURSOR_PURPOSE, `${c.x}:${c.s}:${c.h}`);

/** Signed (`m`): the client cannot move the position or make an expired cursor look fresh. */
function signChangesCursor(c: ChangesCursor): string {
  return encodeCursor({ ...c, m: macOf(c) });
}

function decodeChangesCursor(cursor: string): ChangesCursor {
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      typeof c.x === 'string' &&
      /^\d{1,20}$/.test(c.x) &&
      Number.isSafeInteger(c.s) &&
      (c.s as number) >= -1 &&
      Number.isSafeInteger(c.h) &&
      typeof c.m === 'string'
    ) {
      const parsed = { x: c.x, s: c.s as number, h: c.h as number };
      if (safeEqual(c.m, macOf(parsed))) return parsed;
    }
  } catch {
    // falls through
  }
  throw new AppError('VALIDATION_FAILED', { field: 'cursor' });
}

const HOUR_MS = 3_600_000;

/**
 * `GET /v2/changes`: the site's delta feed (S7-03). Every change of a public listing or unit the site could show
 * exactly once across pages, in commit-safe order (`search.siteChanges`): UPSERT when the target is on the site now,
 * REMOVE when it is not. A network site reads its own changes and those of targets shared with its agency before or
 * after the change — never the rest of the platform's activity. Cursors are signed and carry the hour they were
 * handed out (so a page's body stays the same within the hour); a cursor or `since` older than the log's retention
 * answers `CHANGES_EXPIRED` (rebuild from the sitemap). Two statements (three from `since`).
 */
export async function changes(site: ApiSite, q: WebsiteChangesQuery): Promise<WebsiteChangesPage> {
  const now = clock.now();
  const oldest = now.getTime() - search.PUBLIC_CHANGES_RETENTION_DAYS * 86_400_000;
  let after: search.ChangePosition | undefined;
  let since: Date | undefined;
  if (q.cursor !== undefined) {
    const c = decodeChangesCursor(q.cursor);
    // The hour it was handed out, rounded down: at most an hour older than the client's last poll.
    if (c.h * HOUR_MS < oldest) throw new AppError('CHANGES_EXPIRED');
    after = { tx: c.x, seq: c.s };
  } else {
    since = new Date(q.since as string);
    if (since.getTime() < oldest) throw new AppError('CHANGES_EXPIRED');
  }
  // A site showing nothing still pages its agency's changes (all REMOVE), so its cursor keeps moving.
  const inventory = site.inventory ?? { ownerAgencyIds: [site.scope.agencyId], requestId: '' };
  const audience: search.ChangeAudience =
    inventory.networkOf === undefined ? { ownerAgencyId: site.scope.agencyId } : { networkOf: inventory.networkOf };
  const page = await search.withSiteRead(inventory, (tx) =>
    search.siteChanges(tx, inventory, { after, since, audience, limit: q.limit }),
  );
  const shown = shownSite(site);
  return {
    items: page.rows.map((r) => ({
      ref: websites.siteRef(shown, r),
      kind: r.kind,
      change: site.inventory && r.present ? ('UPSERT' as const) : ('REMOVE' as const),
      changedAt: r.changedAt.toISOString(),
    })),
    nextCursor: signChangesCursor({
      x: page.position.tx,
      s: page.position.seq,
      h: Math.floor(now.getTime() / HOUR_MS),
    }),
    hasMore: page.rows.length === q.limit,
    scope: site.tag,
  };
}

// ── Sitemap ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A sitemap cursor: after a listing's public code (`c`), or in the development part (`d`: '' = its start). */
type SitemapCursor = { part: 'listings'; after: string } | { part: 'developments'; after: string | undefined };

function decodeSitemapCursor(cursor: string): SitemapCursor {
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof c.c === 'string' && PublicCode.safeParse(c.c).success) return { part: 'listings', after: c.c };
    if (c.d === '') return { part: 'developments', after: undefined };
    if (typeof c.d === 'string' && PublicCode.safeParse(c.d).success) return { part: 'developments', after: c.d };
  } catch {
    // falls through
  }
  throw new AppError('VALIDATION_FAILED', { field: 'cursor' });
}

/**
 * `GET /v2/sitemap`: the site's listing pages (shown reference, slug in `lang`, last change), one page per cursor in
 * a stable order (public codes: never an internal id). One statement, plus the overrides when network listings are
 * on the page.
 */
export async function sitemap(site: ApiSite, q: WebsiteSitemapQuery): Promise<WebsiteSitemapPage> {
  const lang = langOf(site, q.lang);
  const inventory = site.inventory;
  if (!inventory) return { items: [], nextCursor: null };
  const cur = q.cursor === undefined ? undefined : decodeSitemapCursor(q.cursor);
  if (cur?.part === 'developments') return sitemapDevelopments(site, inventory, lang, q.limit, cur.after);
  const after = cur?.after;
  return search.withSiteRead(inventory, async (tx) => {
    const rows = await search.sitemapPage(tx, inventory, {
      after,
      limit: q.limit,
      locale: lang,
      fallback: site.scope.defaultLocale,
      part: 'sitemap',
    });
    const page = rows.slice(0, q.limit);
    const view = await viewFor(tx, site, lang, page);
    // S7-F10 review: the three shown fields, not whole cards (the statement is ~5 ms of a ~45 ms page).
    const entries = websites.serializeSitemapEntries(view, page.map(owned<ListingCardDoc | UnitCardDoc>));
    const last = page[page.length - 1];
    return {
      items: entries.map((entry, i) => ({
        ref: entry.ref,
        kind: entry.kind,
        slug: entry.slug,
        updatedAt: (page[i] as search.PublicDocRow).updatedAt.toISOString(),
      })),
      nextCursor:
        rows.length > q.limit && last?.publicCode
          ? encodeCursor({ c: last.publicCode })
          : // S8-F24: the listing pages end; the development pages follow (only when the site shows new builds).
            newBuildsOf(site)
            ? encodeCursor({ d: '' })
            : null,
    };
  });
}

/** Development entries per sitemap page at most: each carries a representative unit's card (S8-F24). */
const SITEMAP_DEVELOPMENTS_MAX = 100;

/**
 * The development part of `GET /v2/sitemap` (S8-F24): the site's developments through the same read path as
 * `/v2/developments` (development rows + read models, newest first, white-labelled), as `DEVELOPMENT` entries with
 * the later of the row's and its representative unit's change as `updatedAt`. One statement, plus the overrides.
 */
async function sitemapDevelopments(
  site: ApiSite,
  inventory: NonNullable<ApiSite['inventory']>,
  lang: string,
  limit: number,
  after: string | undefined,
): Promise<WebsiteSitemapPage> {
  const take = Math.min(limit, SITEMAP_DEVELOPMENTS_MAX);
  return search.withSiteRead(inventory, async (tx) => {
    const rows = await search.developmentPage(tx, inventory, {
      after,
      limit: take,
      locale: lang,
      fallback: site.scope.defaultLocale,
    });
    const page = rows.slice(0, take);
    const view = await viewFor(tx, site, lang, viewRows(page));
    const cards = websites.serializeDevelopmentCards(view, page.map(developmentItem<UnitCardDoc>));
    const last = page[page.length - 1];
    return {
      items: cards.map((card, i) => ({
        ref: card.ref,
        kind: 'DEVELOPMENT' as const,
        slug: card.slug,
        updatedAt: (page[i] as search.DevelopmentRow).updatedAt.toISOString(),
      })),
      nextCursor: rows.length > take && last ? encodeCursor({ d: last.code }) : null,
    };
  });
}

// ── Developments (S7-F6) ────────────────────────────────────────────────────────────────────────────────────────

/** The site's new-build inventory, or null: it shows none (nothing at all, or a CUSTOM site without new builds). */
const newBuildsOf = (site: ApiSite) =>
  site.inventory && site.inventory.restrict?.newBuilds !== false ? site.inventory : null;

/** A page cursor naming the last item's public code (`d` developments, `u` units), never an internal id. */
function decodeCodeCursor(cursor: string, key: 'd' | 'u'): string {
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    const code = c[key];
    if (typeof code === 'string' && PublicCode.safeParse(code).success) return code;
  } catch {
    // falls through
  }
  throw new AppError('VALIDATION_FAILED', { field: 'cursor' });
}

const developmentItem = <D extends UnitCardDoc>(r: search.DevelopmentRow): websites.DevelopmentItem<D> => ({
  ...r,
  doc: r.doc as D,
});

/** The rows the serializer's view needs: each development with its owner and a unit document (overrides by id). */
const viewRows = (rows: readonly search.DevelopmentRow[]) =>
  rows.map((r) => ({ targetId: r.developmentId, ownerAgencyId: r.ownerAgencyId, doc: r.doc }));

/**
 * `GET /v2/developments` (S7-F6): the site's new-build developments — those with AVAILABLE or RESERVED units in its
 * inventory — newest first, white-labelled like listings. One statement, plus the overrides and owner identities when
 * another agency's development is on the page.
 */
export async function developments(site: ApiSite, q: WebsiteDevelopmentsQuery): Promise<WebsiteDevelopmentPage> {
  const lang = langOf(site, q.lang);
  const inventory = newBuildsOf(site);
  if (!inventory) return { items: [], nextCursor: null };
  const after = q.cursor === undefined ? undefined : decodeCodeCursor(q.cursor, 'd');
  return search.withSiteRead(inventory, async (tx) => {
    const rows = await search.developmentPage(tx, inventory, {
      after,
      limit: q.limit,
      locale: lang,
      fallback: site.scope.defaultLocale,
      locationIds: q.locations,
    });
    const page = rows.slice(0, q.limit);
    for (const r of page) site.edge.developments.add(r.developmentId);
    const view = await viewFor(tx, site, lang, viewRows(page));
    const last = page[page.length - 1];
    return {
      items: websites.serializeDevelopmentCards(view, page.map(developmentItem<UnitCardDoc>)),
      nextCursor: rows.length > q.limit && last ? encodeCursor({ d: last.code }) : null,
    };
  });
}

/**
 * `GET /v2/developments/{ref}` (S7-F6): a development by the reference the site shows — an own development's own
 * reference, another agency's `<prefix>-<code>`. 1–2 statements.
 */
export async function developmentDetail(site: ApiSite, ref: string, lang?: string): Promise<WebsiteDevelopmentDetail> {
  const locale = langOf(site, lang);
  const inventory = newBuildsOf(site);
  if (!inventory) throw new AppError('DEVELOPMENT_NOT_FOUND');
  return search.withSiteRead(inventory, async (tx) => {
    const row = await search.developmentByRef(tx, inventory, ref, locale, site.scope.defaultLocale);
    if (!row) throw new AppError('DEVELOPMENT_NOT_FOUND');
    site.edge.developments.add(row.developmentId);
    const view = await viewFor(tx, site, locale, viewRows([row]));
    return websites.serializeDevelopmentDetail(view, developmentItem<UnitDetailDoc>(row));
  });
}

/**
 * `GET /v2/developments/{ref}/units` (S7-F6): the development's live unit table on this site — its AVAILABLE and
 * RESERVED units in the inventory, in the developer's unit order — as unit cards. A development with none here is not
 * on the site (`DEVELOPMENT_NOT_FOUND`). 1–2 statements.
 */
export async function developmentUnits(site: ApiSite, ref: string, q: WebsiteUnitsQuery): Promise<WebsiteUnitPage> {
  const lang = langOf(site, q.lang);
  const inventory = newBuildsOf(site);
  if (!inventory) throw new AppError('DEVELOPMENT_NOT_FOUND');
  const after = q.cursor === undefined ? undefined : decodeCodeCursor(q.cursor, 'u');
  return search.withSiteRead(inventory, async (tx) => {
    const { found, anchored, developmentId, rows } = await search.developmentUnitsPage(tx, inventory, {
      ref,
      after,
      limit: q.limit,
      locale: lang,
      fallback: site.scope.defaultLocale,
    });
    if (!found) throw new AppError('DEVELOPMENT_NOT_FOUND');
    if (developmentId) site.edge.developments.add(developmentId);
    // The cursor's unit left the development's public units: the position is gone (start again).
    if (!anchored) throw new AppError('VALIDATION_FAILED', { field: 'cursor' });
    const page = rows.slice(0, q.limit);
    for (const r of page) site.edge.targets.add(r.targetId);
    const view = await viewFor(tx, site, lang, page);
    const last = page[page.length - 1];
    return {
      items: websites.serializeUnitCards(view, page.map(owned<UnitCardDoc>)),
      nextCursor: rows.length > q.limit && last?.publicCode ? encodeCursor({ u: last.publicCode }) : null,
    };
  });
}
