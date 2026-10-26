import { PortalQuery } from '@inmolink/contracts';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { UI_LOCALES } from '@inmolink/i18n';
import { newId } from '@inmolink/platform/ids';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { LOCAL_PUBLIC_URL, publicConfig } from '@/server/env';

/**
 * The portal pages' reads (S15-01): core's portal read services (`website-api/portal.ts`) after the app's lazy setup,
 * deduplicated per request (`generateMetadata` and the page share one read). Thin: no rules here.
 */

export interface PortalSettings {
  /** Canonical / hreflang / Open Graph origin. */
  origin: string;
  /** Map tiles (`{z}/{x}/{y}`) and their attribution; null: no map. */
  map: { tileUrl: string; attribution: string } | null;
}

export const portalSettings = cache(async (): Promise<PortalSettings> => {
  const c = await publicConfig();
  return {
    origin: c.PORTAL_URL ?? c.PUBLIC_URL ?? LOCAL_PUBLIC_URL,
    map: c.PORTAL_MAP_TILE_URL ? { tileUrl: c.PORTAL_MAP_TILE_URL, attribution: c.PORTAL_MAP_ATTRIBUTION ?? '' } : null,
  };
});

/** The portal's page locales (the UI locales: every page has a prefix). */
export const PORTAL_LOCALES: readonly string[] = UI_LOCALES;

/**
 * A page's locale, or the 404 (layouts and pages render side by side: the layout's own check does not stop a page's
 * reads for `/xx/…`).
 */
export function assertPortalLocale(locale: string): void {
  if (!PORTAL_LOCALES.includes(locale)) notFound();
}

export const listingByCode = cache(async (locale: string, code: string) => {
  await publicConfig();
  return websiteApi.portalListing({ locale, code, requestId: newId() });
});

export const developmentByCode = cache(async (locale: string, code: string) => {
  await publicConfig();
  return websiteApi.portalDevelopment({ locale, code, requestId: newId() });
});

export const locationOf = cache(async (locale: string, slugs: string) => {
  await publicConfig();
  return websiteApi.portalLocation(locale, slugs.split('/'));
});

export const zoneOf = cache(async (locale: string, slug: string) => {
  await publicConfig();
  return websiteApi.portalZone(locale, slug);
});

export const placeOf = cache(async (locale: string, id: string) => {
  await publicConfig();
  return websiteApi.portalPlaceOf(locale, id);
});

export const catalogOf = cache(async (locale: string) => {
  await publicConfig();
  return websiteApi.portalCatalog(locale);
});

export const directoryOf = cache(async (locale: string) => {
  await publicConfig();
  return websiteApi.portalDirectory(locale);
});

export async function locationPaths(id: string) {
  await publicConfig();
  return websiteApi.portalLocationPaths(id, PORTAL_LOCALES);
}

export async function zoneSlugs(id: string) {
  await publicConfig();
  return websiteApi.portalZoneSlugs(id, PORTAL_LOCALES);
}

export async function searchPortal(input: Omit<websiteApi.PortalSearchInput, 'requestId'>) {
  await publicConfig();
  return websiteApi.portalSearch({ ...input, requestId: newId() });
}

/** A page's `searchParams` as the portal reads them (junk values dropped). */
export function parseQuery(params: Record<string, string | string[] | undefined>): PortalQuery {
  return PortalQuery.parse(params);
}
