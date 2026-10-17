/**
 * Taxonomy names for read models (S5-01, PATTERNS §14) for the search worker (PATTERNS §12 "Cross-module functions
 * for workers"): raw `tx`, no authorization. Read models carry names in their locale, so a public page shows a
 * listing without reading taxonomy tables; a rename reaches them with the next rebuild of the listing (or
 * `pnpm ops:rebuild-read-models`).
 */
import type { LocationLevel } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { FALLBACK_CONTENT_LOCALE } from '@inmolink/i18n';
import * as repo from './repo';

export interface ReadModelTaxonomy {
  /** Taxonomy id → locale → name and slug. */
  names: Map<string, Map<string, { name: string; slug: string }>>;
  /** Location id → it and its ancestors. */
  lineage: Map<string, { id: string; level: LocationLevel }[]>;
}

/**
 * The names of these locations (with their ancestors), property types and features in `locales` and the fallback
 * content locale. Two statements for any number.
 */
export async function taxonomyForReadModels(
  tx: Tx,
  ids: { locations: readonly string[]; propertyTypes: readonly string[]; features: readonly string[] },
  locales: readonly string[],
): Promise<ReadModelTaxonomy> {
  const lineage = new Map<string, { id: string; level: LocationLevel }[]>();
  const placeIds = new Set<string>();
  for (const r of await repo.readModelLineage(tx, [...new Set(ids.locations)])) {
    const list = lineage.get(r.origin) ?? [];
    list.push({ id: r.id, level: r.level });
    lineage.set(r.origin, list);
    placeIds.add(r.id);
  }
  const names = new Map<string, Map<string, { name: string; slug: string }>>();
  const rows = await repo.readModelNames(
    tx,
    {
      locations: [...placeIds],
      propertyTypes: [...new Set(ids.propertyTypes)],
      features: [...new Set(ids.features)],
    },
    [...new Set([...locales, FALLBACK_CONTENT_LOCALE])],
  );
  for (const r of rows) {
    const byLocale = names.get(r.id) ?? new Map();
    byLocale.set(r.locale, { name: r.name, slug: r.slug });
    names.set(r.id, byLocale);
  }
  return { names, lineage };
}

/** An item's name and slug in `locale`, else the fallback content locale's, else any; null when it has none. */
export function taxonName(
  tax: ReadModelTaxonomy,
  id: string,
  locale: string,
): { id: string; name: string; slug: string } | null {
  const byLocale = tax.names.get(id);
  const text = byLocale?.get(locale) ?? byLocale?.get(FALLBACK_CONTENT_LOCALE) ?? byLocale?.values().next().value;
  return text ? { id, ...text } : null;
}
