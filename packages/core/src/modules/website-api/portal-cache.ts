import { withSystem } from '@inmolink/db';
import { pageTags } from '@inmolink/platform/cache';
import { clock } from '@inmolink/platform/clock';
import * as search from '../search';
import type { PortalPage } from './portal-seo';

/**
 * S15-F7: the portal's ISR pages (listing, development — ADR 0019 (A)) carry cache tags; what they show changing marks
 * the tags on redis-cache (`pageTags.markChanged`) from the worker's outbox subscribers (`subscriptions.ts`), and every
 * public instance's page cache (`PageCacheHandler`, platform) drops the tagged pages on its next request:
 *
 * - `portal:t:<listing id>` — the listing's public document changed (price, texts, withdrawn: `search.publicDocs.changed`);
 * - `portal:d:<development id>` — the development's or one of its units' documents changed (same event);
 * - `portal:c:<public code>` — the same event, by code: a listing's or development's cached 404 (withdrawn, then
 *   restored) carries only the code its URL names;
 * - `portal:a:<agency id>` — the listing agency's standing (`agencies.status.changed`), name or kind
 *   (`agencies.details.updated`) or published contacts (`agencies.profile.updated`) changed.
 *
 * Why shared tag times and not an HTTP revalidation endpoint: a worker calling `revalidateTag` through one public
 * instance's endpoint reaches only the instance the load balancer picks; the tag times reach every instance on its
 * next request and need no instance list, secret or public route. A redelivered event marks the tag again at its
 * (later) delivery time — harmless: the tag's pages are rendered once more; a mark never moves a time back (the store
 * keeps the later one). Cost: one MGET per ISR hit.
 *
 * Timing: a document change is marked at once — the page reads the document itself, and the page cache drops anything
 * stored up to its render margin after the mark (a render that read before the change; clock skew). An agency change
 * shows only once the public processes' own caches have turned over — the listed-agency set and the agency contacts
 * are used at most a minute old (`portal.ts`) — so the mark is a minute ahead (`PORTAL_AGENCY_SETTLE_MS`): the
 * agency's pages stay uncached (and are not stored) until then plus the render margin, instead of a fresh render
 * keeping the old contacts for the page's ISR lifetime. The agency-contact cache is bounded (60 s), not cleared: the
 * worker cannot reach the public processes' memory.
 */

/** As long as the public processes may use a cached listed-agency set or agency contacts (60 s, `portal.ts`). */
export const PORTAL_AGENCY_SETTLE_MS = 60_000;

export const portalPageTag = {
  listing: (id: string) => `portal:t:${id}`,
  development: (id: string) => `portal:d:${id}`,
  agency: (id: string) => `portal:a:${id}`,
  /** A public code (upper case): what a cached 404 of a listing or development URL carries. */
  code: (code: string) => `portal:c:${code.toUpperCase()}`,
};

/**
 * The cache tags of a page's ISR copy (`unstable_cache` tags in the page; PATTERNS §19): the listing or development,
 * its code and its agency. Pages rendered per request (search, location, zone, agency, home) carry none — they read
 * fresh data and the CDN keeps them briefly (`s-maxage`).
 */
export function portalPageTags(page: PortalPage): string[] {
  switch (page.kind) {
    case 'listing':
      return [
        // The own view's id: the listing's (`serializeDetail` masks ids on network views only).
        portalPageTag.listing(page.listing.detail.id),
        portalPageTag.code(page.listing.code),
        ...(page.listing.agency ? [portalPageTag.agency(page.listing.agency.id)] : []),
      ];
    case 'development':
      return [
        portalPageTag.development(page.development.detail.id),
        portalPageTag.code(page.development.code),
        ...(page.development.agency ? [portalPageTag.agency(page.development.agency.id)] : []),
      ];
    default:
      return [];
  }
}

/**
 * Public documents changed: their listing and development pages (and cached 404s of their codes) drop their cached
 * copies. One statement (the codes).
 */
export async function invalidatePortalDocs(input: {
  targetIds: readonly string[];
  developmentIds: readonly string[];
}): Promise<void> {
  const ids = [...input.targetIds, ...input.developmentIds];
  const codes = await withSystem('websiteApi.portal page codes', (tx) => search.publicCodes(tx, ids));
  const tags = [
    ...input.targetIds.map(portalPageTag.listing),
    ...input.developmentIds.map(portalPageTag.development),
    ...[...codes.values()].map(portalPageTag.code),
  ];
  await pageTags.markChanged(tags, clock.nowMs());
}

/** An agency's standing, name or contacts changed: its listing and development pages stay uncached until it shows. */
export async function invalidatePortalAgency(agencyId: string): Promise<void> {
  await pageTags.markChanged([portalPageTag.agency(agencyId)], clock.nowMs() + PORTAL_AGENCY_SETTLE_MS);
}
