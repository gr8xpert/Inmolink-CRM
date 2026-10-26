import { z } from 'zod';

/**
 * The public portal's search URL (S15-01, inmolink.es): the query string of a search or location page, read leniently —
 * a visitor's (or a crawler's) junk value is dropped, never an error page. Names follow the legacy portal where it
 * had them (`price_min`, `price_max`, `bedrooms_min`, `page`), so its links keep their meaning after the 301s
 * (S15-02). Prices in whole euros; types by slug (a type or a type group), features by portal key.
 */

/** Results per page (numbered, crawlable pages). */
export const PORTAL_PAGE_SIZE = 20;
/** The deepest page: the search engine pages up to 10,000 results. */
export const PORTAL_MAX_PAGE = 10_000 / PORTAL_PAGE_SIZE;

export const PORTAL_SORTS = ['latest', 'price_asc', 'price_desc'] as const;
export type PortalSort = (typeof PORTAL_SORTS)[number];

/** The price filter's fixed steps in euros (the legacy portal's list). */
export const PORTAL_PRICE_STEPS = [
  50_000, 60_000, 70_000, 80_000, 90_000, 100_000, 110_000, 120_000, 130_000, 140_000, 150_000, 160_000, 170_000,
  175_000, 180_000, 190_000, 200_000, 225_000, 250_000, 275_000, 300_000, 325_000, 350_000, 375_000, 400_000, 425_000,
  450_000, 475_000, 500_000, 600_000, 700_000, 800_000, 900_000, 1_000_000, 1_250_000, 1_500_000, 1_750_000, 2_000_000,
  2_500_000, 3_000_000, 4_000_000, 5_000_000, 7_500_000, 10_000_000, 15_000_000, 20_000_000,
] as const;
/** Bedroom and bathroom steps (minimum and maximum). */
export const PORTAL_ROOM_STEPS = [1, 2, 3, 4, 5] as const;
/** Minimum built size steps in m². */
export const PORTAL_BUILD_STEPS = [50, 100, 150, 200, 250] as const;
/** Feature filters the portal offers (each a set of taxonomy features, resolved by name). */
export const PORTAL_FEATURES = ['sea-views', 'golf'] as const;
export type PortalFeature = (typeof PORTAL_FEATURES)[number];

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The first value of a repeated parameter; an empty (a form's "any") or invalid one is dropped. */
const one = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => {
    const first = Array.isArray(v) ? v[0] : v;
    return first === '' ? undefined : first;
  }, schema.optional().catch(undefined));
/** Every value of a repeated parameter, invalid ones dropped, at most `max`. */
const many = <T extends z.ZodType>(item: T, max: number) =>
  z.preprocess(
    (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]),
    z
      .array(z.unknown())
      .transform((xs) => [...new Set(xs.flatMap((x) => (item.safeParse(x).success ? [x as z.output<T>] : [])))])
      .transform((xs) => xs.slice(0, max)),
  );

const whole = (max: number) => z.coerce.number().int().min(0).max(max);

export const PortalQuery = z.object({
  price_min: one(whole(1_000_000_000)),
  price_max: one(whole(1_000_000_000)),
  bedrooms_min: one(whole(50)),
  bedrooms_max: one(whole(50)),
  bathrooms_min: one(whole(50)),
  bathrooms_max: one(whole(50)),
  build_min: one(whole(100_000)),
  type: many(z.string().max(80).regex(SLUG), 30),
  feature: many(z.enum(PORTAL_FEATURES), PORTAL_FEATURES.length),
  sort: one(z.enum(PORTAL_SORTS)),
  page: one(z.coerce.number().int().min(1).max(PORTAL_MAX_PAGE)),
});
export type PortalQuery = z.output<typeof PortalQuery>;

/** The query parameters a page keeps in its links, in a stable order (canonical URLs, pagination). */
export const PORTAL_QUERY_KEYS = [
  'type',
  'price_min',
  'price_max',
  'bedrooms_min',
  'bedrooms_max',
  'bathrooms_min',
  'bathrooms_max',
  'build_min',
  'feature',
  'sort',
  'page',
] as const satisfies readonly (keyof PortalQuery)[];

/**
 * Whether a query narrows the results (any filter or a sort; the page alone does not). S15-F7: here, so the portal's
 * proxy, pages and core's metadata (`website-api/portal-seo.ts`) read one rule.
 */
export function portalQueryHasFilters(q: PortalQuery): boolean {
  return PORTAL_QUERY_KEYS.some((k) => {
    if (k === 'page') return false;
    const v = q[k];
    return Array.isArray(v) ? v.length > 0 : v !== undefined && !(k === 'sort' && v === 'latest');
  });
}

/**
 * A query string in a stable order without defaults (`sort=latest`, `page=1`), `?`-prefixed or empty: links,
 * canonicals and pagination always spell one search the same way.
 */
export function portalQueryString(q: PortalQuery, change: Partial<PortalQuery> = {}): string {
  const merged: PortalQuery = { ...q, ...change };
  const params = new URLSearchParams();
  for (const k of PORTAL_QUERY_KEYS) {
    const v = merged[k];
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of [...v].sort()) params.append(k, String(x));
    else if (!(k === 'sort' && v === 'latest') && !(k === 'page' && v === 1)) params.append(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}
