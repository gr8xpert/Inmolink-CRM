import { hmacSha256 } from '@inmolink/platform/crypto';

/**
 * Edge cache tags (S7-06, ADR 0012 #5). Cacheable website API answers carry `Cache-Tag`s naming what they show; the
 * worker purges a tag when that thing changes. Cloudflare strips `Cache-Tag` before answering a client, and the tags
 * are keyed hashes anyway (never an internal id: a network listing's id would link it across sites). Hex: Cloudflare
 * compares tags case-insensitively.
 *
 * - `s` site — every answer of the site (its policy, branding or locales changed);
 * - `k` key — every answer to that API key (rotated or revoked);
 * - `t` target — answers showing a listing or unit (its detail, first pages and unit tables listing it);
 * - `d` development — a development's card, detail and unit table.
 *
 * Lists are tagged with the targets on them, so a change purges every page showing the target on every site with one
 * tag — no fan-out over the sites a network listing is on. A target new to a list's results is not on its cached page
 * yet: that page follows within its TTL (60 s).
 */
export type EdgeTagKind = 's' | 'k' | 't' | 'd';

/** Tags on one answer at most (Cloudflare: 16 KB of `Cache-Tag`, ~700 of ours); more → not edge-cached. */
export const EDGE_MAX_TAGS = 300;

/**
 * Edge lifetimes per endpoint in seconds (ADR 0012 #5: 60–300 s) — `s-maxage` and `stale-while-revalidate` of first
 * pages and details while the edge cache is on. `changes` is never edge-cached (a cursor poll). The sitemap is capped
 * at 240 s like the rest (S7-06 review: it carries no listing tags, so its TTL is its freshness).
 */
export const WEBSITE_API_TTL = {
  listings: 60,
  detail: 300,
  changes: 30,
  sitemap: 240,
  // S7-F6: unit tables are live (status, price), so as short as search
  developments: 60,
  development: 300,
  units: 60,
} as const;

/**
 * Listing and development purges (`t`, `d`) of changes older than this are dropped: every edge copy showing them
 * has expired by then — the longest lifetime is fresh for its TTL, then served stale once more within
 * `stale-while-revalidate` (= TTL), so 2 × the largest TTL. Bounds the purge work of a burst (a full rebuild) to what
 * still matters. Site and key purges (`s`, `k`) are never dropped: they also end access (suspension, revocation).
 */
export const EDGE_PURGE_HORIZON_MS = 2 * Math.max(...Object.values(WEBSITE_API_TTL)) * 1_000;

let tagKey: Buffer | undefined;

/** Boot (feed-api and worker): the key tags are made with (`HMAC_KEY`, purpose-separated). */
export function configureEdgeCache(options: { tagKey: string }): void {
  if (!options.tagKey) throw new Error('website-api: edge tagKey is required');
  tagKey = Buffer.from(options.tagKey);
}

/** The tag of one site, key, target or development. */
export function edgeTag(kind: EdgeTagKind, id: string): string {
  if (!tagKey) throw new Error('website-api: configureEdgeCache() was not called');
  return `${kind}${Buffer.from(hmacSha256(tagKey, 'website-api.edge-tag', `${kind}:${id}`), 'base64url')
    .toString('hex')
    .slice(0, 20)}`;
}

/** What one request's answer showed (filled by the use cases), for its tags. Internal ids; never sent as they are. */
export interface EdgeSeen {
  targets: Set<string>;
  developments: Set<string>;
}

export const newEdgeSeen = (): EdgeSeen => ({ targets: new Set(), developments: new Set() });

/**
 * The `Cache-Tag`s of a site answer: its site and key, and what it showed. Null when tags cannot be made (not
 * configured) or would be too many — such an answer is not edge-cached.
 */
export function edgeTagsOf(site: { scope: { siteId: string }; keyId: string | null; edge: EdgeSeen }): string[] | null {
  if (!tagKey) return null;
  const tags = [edgeTag('s', site.scope.siteId)];
  if (site.keyId) tags.push(edgeTag('k', site.keyId));
  for (const id of site.edge.targets) tags.push(edgeTag('t', id));
  for (const id of site.edge.developments) tags.push(edgeTag('d', id));
  return tags.length > EDGE_MAX_TAGS ? null : tags;
}

/** Whether tags can be made (feed-api adds none, and the worker purges none, before boot configured them). */
export function edgeTagsConfigured(): boolean {
  return tagKey !== undefined;
}
