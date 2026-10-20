/**
 * Website sites (S7-01, PLAN §6 Website delivery, §9.1): an agency's websites — where each runs, which listings it
 * shows (inventory policy) and how it presents them (reference prefix, locales, contact overrides). Website API keys
 * are bound to one site (S1-05 keys, `api_keys.site_id`); the website API answers with that site's inventory.
 *
 * Inventory policies, as search filters (`siteSearchScope` → `search.searchPublicListings`):
 * - OWN_ONLY — the agency's own PUBLIC listings and new-build units.
 * - OWN_PLUS_NETWORK — also other agencies' PUBLIC listings and units shared with the agency: shared with everyone,
 *   or by an owner that prefers it (S6-F2), and not hidden from the network for freshness.
 * - CUSTOM — own and/or network, narrowed by locations, property types, a price band and new-builds on/off.
 *
 * feed-api reads a key's site through `siteScope` (no `ctx`: it runs before a tenant session, as `app_public`),
 * cached `SITE_CACHE.TTL_SECONDS` in Redis and `LOCAL_TTL_SECONDS` in-process. A change drops the shared entry when
 * its event is delivered, so a site's answers follow a policy change at once — and within 60 s without the event.
 */
import type {
  CreateSiteInput,
  PageQuery,
  SiteContact,
  SiteDto,
  SiteInventoryFilters,
  SitePage,
  SiteParams,
  UpdateSiteInput,
} from '@inmolink/contracts';
import { withPublicRead } from '@inmolink/db';
import { CONTENT_LOCALES, FALLBACK_CONTENT_LOCALE, isContentLocale } from '@inmolink/i18n';
import { type CacheKey, cache, cacheKey } from '@inmolink/platform/cache';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import type { Ctx } from '../../context';
import { decodeCursor, toPage } from '../../pagination';
import * as agencies from '../agencies';
import * as compliance from '../compliance';
import { websitesEvents } from './events';
import { assertCan } from './policy';
import * as repo from './repo';

/** At most this many sites per agency. */
export const MAX_SITES = 20;

/** The site lookup cache (feed-api): a policy change shows within `TTL_SECONDS` even without its event. */
export const SITE_CACHE = { TTL_SECONDS: 45, LOCAL_TTL_SECONDS: 15 } as const;

/** Cache key of one site's scope. No tags (one Redis key per site; changes `cache.delete` it). */
export function siteCacheKey(siteId: string): CacheKey {
  return cacheKey({ v: 1, module: 'websites', entity: 'site', scope: 'global', id: siteId });
}

function toSiteDto(row: repo.SiteRow): SiteDto {
  return {
    id: row.id,
    name: row.name,
    domains: row.domains,
    mode: row.mode,
    inventoryPolicy: row.inventoryPolicy,
    inventoryFilters: (row.inventoryFilters as SiteInventoryFilters | null) ?? null,
    referencePrefix: row.referencePrefix,
    locales: row.locales,
    defaultLocale: row.defaultLocale,
    contact: (row.contact as SiteContact | null) ?? null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * A value as JSON with object keys sorted: jsonb stores keys in its own order (shortest first), the contracts in
 * schema order, so a plain `JSON.stringify` would see every unchanged filter or contact as changed.
 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

/** Content locales only (`CONTENT_LOCALES`): a site publishes listings' texts in them. */
function assertContentLocales(locales: readonly string[]): void {
  if (!locales.every(isContentLocale)) {
    throw new AppError('VALIDATION_FAILED', { field: 'locales', allowed: CONTENT_LOCALES });
  }
}

// ── Dashboard ─────────────────────────────────────────────────────────────────────────────────────

/** The agency's sites, oldest first. */
export async function listSites(ctx: Ctx, q: PageQuery): Promise<SitePage> {
  assertCan(ctx, 'websites.read');
  const rows = await repo.listSites(ctx.tx, ctx.tenant.agencyId, { limit: q.limit, cursor: decodeCursor(q.cursor) });
  return toPage(rows, q.limit, (r) => ({ at: r.createdAt, id: r.id }), toSiteDto);
}

export async function getSite(ctx: Ctx, params: SiteParams): Promise<SiteDto> {
  assertCan(ctx, 'websites.read');
  const row = await repo.getSite(ctx.tx, ctx.tenant.agencyId, params.siteId);
  if (!row) throw new AppError('SITE_NOT_FOUND');
  return toSiteDto(row);
}

/** Adds a site (agency admins; at most `MAX_SITES`). */
export async function createSite(ctx: Ctx, input: CreateSiteInput): Promise<SiteDto> {
  assertCan(ctx, 'websites.manage');
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  assertContentLocales(input.locales);
  const { agencyId } = ctx.tenant;
  // Serialises concurrent creates of the agency, so the cap cannot be raced.
  await agencies.lockAgencyStatus(ctx.tx, agencyId, 'update');
  if ((await repo.countSites(ctx.tx, agencyId)) >= MAX_SITES) {
    throw new AppError('SITE_LIMIT_REACHED', { limit: MAX_SITES });
  }
  const row = await repo.insertSite(ctx.tx, {
    id: newId(),
    agencyId,
    name: input.name,
    domains: input.domains,
    mode: input.mode,
    inventoryPolicy: input.inventoryPolicy,
    inventoryFilters: input.inventoryFilters,
    referencePrefix: input.referencePrefix,
    locales: input.locales,
    defaultLocale: input.locales[0] as string,
    contact: input.contact,
    createdBy: ctx.actor.userId,
    createdAt: clock.now(),
  });
  await emit(ctx.tx, websitesEvents.siteCreated({ siteId: row.id, agencyId }));
  await compliance.audit(
    ctx,
    'websites.site.created',
    { type: 'site', id: row.id },
    { mode: row.mode, inventoryPolicy: row.inventoryPolicy },
  );
  return toSiteDto(row);
}

/**
 * Changes a site (agency admins): the fields sent replace the stored ones, on the version the edit was made on
 * (`VERSION_CONFLICT` otherwise). A change takes effect on the site's website API answers within 60 s.
 */
export async function updateSite(ctx: Ctx, params: SiteParams, input: UpdateSiteInput): Promise<SiteDto> {
  assertCan(ctx, 'websites.manage');
  if (input.locales) assertContentLocales(input.locales);
  const { agencyId } = ctx.tenant;
  const current = await repo.getSite(ctx.tx, agencyId, params.siteId, true);
  if (!current) throw new AppError('SITE_NOT_FOUND');
  if (current.version !== input.version) {
    throw new AppError('VERSION_CONFLICT', { current: current.version });
  }
  const locales = input.locales ?? current.locales;
  const next: repo.SiteFields = {
    name: input.name ?? current.name,
    domains: input.domains ?? current.domains,
    mode: input.mode ?? current.mode,
    inventoryPolicy: input.inventoryPolicy ?? current.inventoryPolicy,
    inventoryFilters: input.inventoryPolicy ? (input.inventoryFilters ?? null) : current.inventoryFilters,
    referencePrefix: input.referencePrefix === undefined ? current.referencePrefix : input.referencePrefix,
    locales,
    defaultLocale: locales[0] as string,
    contact: input.contact === undefined ? current.contact : input.contact,
  };
  const changed = (Object.keys(next) as (keyof repo.SiteFields)[]).filter(
    (k) => canonical(next[k]) !== canonical(current[k]),
  );
  if (changed.length === 0) return toSiteDto(current);
  const row = await repo.updateSite(ctx.tx, agencyId, current.id, next, clock.now());
  await emit(ctx.tx, websitesEvents.siteChanged({ siteId: row.id, agencyId, version: row.version }));
  await compliance.audit(ctx, 'websites.site.changed', { type: 'site', id: row.id }, { fields: changed });
  return toSiteDto(row);
}

/**
 * The site a new website API key is bound to (identity, S1-05 + S7-01): `siteId` if it is one of the agency's sites
 * (`SITE_NOT_FOUND` otherwise), else the agency's first site — created as an OWN_ONLY site in the agency's content
 * locales when it has none (a WordPress plugin site for a secret key, a widget site for a publishable one).
 */
export async function siteForNewKey(
  ctx: Ctx,
  input: { siteId?: string; keyKind: 'SECRET' | 'PUBLISHABLE' },
): Promise<string> {
  assertCan(ctx, 'websites.read');
  const { agencyId } = ctx.tenant;
  if (input.siteId) {
    const row = await repo.getSite(ctx.tx, agencyId, input.siteId);
    if (!row) throw new AppError('SITE_NOT_FOUND');
    return row.id;
  }
  const first = await repo.firstSiteId(ctx.tx, agencyId);
  if (first) return first;
  const locales = ctx.tenant.locales.filter(isContentLocale);
  // Named after the agency (data, not a UI string); the admin renames it on the websites page.
  const name = ((await agencies.getAgencyName(ctx.tx, agencyId)) ?? '').slice(0, 80) || agencyId.slice(0, 8);
  const created = await createSite(ctx, {
    name,
    domains: [],
    mode: input.keyKind === 'SECRET' ? 'WP_PLUGIN' : 'WIDGET',
    inventoryPolicy: 'OWN_ONLY',
    inventoryFilters: null,
    referencePrefix: null,
    locales: locales.length > 0 ? locales : [FALLBACK_CONTENT_LOCALE],
    contact: null,
  });
  return created.id;
}

// ── Website API ───────────────────────────────────────────────────────────────────────────────────

/** A site as the website API uses it: who it belongs to, how it presents listings, and its inventory. */
export interface SiteScope {
  siteId: string;
  agencyId: string;
  /** The site's version (cache keys and ETags of its answers). */
  version: number;
  mode: repo.WebsiteMode;
  inventoryPolicy: repo.InventoryPolicy;
  inventoryFilters: SiteInventoryFilters | null;
  referencePrefix: string | null;
  locales: string[];
  defaultLocale: string;
  contact: SiteContact | null;
}

/**
 * A site's scope for the website API (feed-api, S7-03), by id — the id comes from the authenticated key, never from
 * the visitor. No `ctx`: it runs before the tenant is known, under `app_public` (like `authenticateApiKey`). Cached
 * (`SITE_CACHE`); unknown ids are never cached. `SITE_NOT_FOUND` when there is no such site.
 */
export async function siteScope(siteId: string): Promise<SiteScope> {
  const row = await cache.get(
    siteCacheKey(siteId),
    { ttlSeconds: SITE_CACHE.TTL_SECONDS, localTtlSeconds: SITE_CACHE.LOCAL_TTL_SECONDS, local: true },
    // `undefined` is never cached: misses always go to the database.
    async () => (await withPublicRead((tx) => repo.findSite(tx, siteId))) ?? undefined,
  );
  if (!row) throw new AppError('SITE_NOT_FOUND');
  return {
    siteId: row.id,
    agencyId: row.agencyId,
    version: row.version,
    mode: row.mode,
    inventoryPolicy: row.inventoryPolicy,
    inventoryFilters: (row.inventoryFilters as SiteInventoryFilters | null) ?? null,
    referencePrefix: row.referencePrefix,
    locales: row.locales,
    defaultLocale: row.defaultLocale,
    contact: (row.contact as SiteContact | null) ?? null,
  };
}

/**
 * A site's inventory as the website search takes it (`search.PublicSearchSite`, structurally): owner agencies, the
 * agency whose network listings are included, and a CUSTOM policy's narrowing. Declared here, not imported: the
 * search module depends on modules that depend on this one (identity → websites).
 */
export interface SiteSearchScope {
  ownerAgencyIds: string[];
  networkOf?: string;
  restrict?: {
    locationIds?: string[];
    propertyTypeIds?: string[];
    priceMinCents?: number;
    priceMaxCents?: number;
    newBuilds?: boolean;
  };
  requestId: string;
}

/** A site's inventory policy as the website search's scope (`search.searchPublicListings`). */
export function siteSearchScope(site: SiteScope, requestId: string): SiteSearchScope {
  switch (site.inventoryPolicy) {
    case 'OWN_ONLY':
      return { ownerAgencyIds: [site.agencyId], requestId };
    case 'OWN_PLUS_NETWORK':
      return { ownerAgencyIds: [site.agencyId], networkOf: site.agencyId, requestId };
    case 'CUSTOM': {
      const f = site.inventoryFilters;
      // A CUSTOM site always has filters (check constraint); without them it shows only its own listings.
      if (!f) return { ownerAgencyIds: [site.agencyId], requestId };
      return {
        ownerAgencyIds: f.includeOwn ? [site.agencyId] : [],
        ...(f.includeNetwork ? { networkOf: site.agencyId } : {}),
        restrict: {
          locationIds: f.locationIds,
          propertyTypeIds: f.propertyTypeIds,
          priceMinCents: f.priceMinCents,
          priceMaxCents: f.priceMaxCents,
          newBuilds: f.newBuilds,
        },
        requestId,
      };
    }
  }
}
