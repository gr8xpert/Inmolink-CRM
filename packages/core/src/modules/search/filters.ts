import type { Filter } from '@inmolink/platform/search';

/**
 * A search's listing attributes as engine-neutral filters (S5-04, S5-05): the same fields and semantics for website
 * and network search — any of the types, anywhere under any of the locations, every one of the features, inclusive
 * ranges, the map's box. Who may see a document is the caller's own filter, never this one.
 */
export interface AttributeQuery {
  kind?: 'LISTING' | 'UNIT';
  developmentId?: string;
  transactionType?: string;
  propertyTypeIds?: string[];
  locationIds?: string[];
  featureIds?: string[];
  priceMinCents?: number;
  priceMaxCents?: number;
  bedsMin?: number;
  bathsMin?: number;
  areaMinM2?: number;
  areaMaxM2?: number;
  geoBox?: { north: number; west: number; south: number; east: number };
}

export function attributeFilters(q: AttributeQuery): Filter[] {
  const filters: Filter[] = [];
  if (q.kind) filters.push({ op: 'eq', field: 'kind', value: q.kind });
  if (q.developmentId) filters.push({ op: 'eq', field: 'developmentId', value: q.developmentId });
  if (q.transactionType) filters.push({ op: 'eq', field: 'transactionType', value: q.transactionType });
  if (q.propertyTypeIds) filters.push({ op: 'in', field: 'propertyTypeId', values: q.propertyTypeIds });
  if (q.locationIds) filters.push({ op: 'in', field: 'locationIds', values: q.locationIds });
  for (const id of q.featureIds ?? []) filters.push({ op: 'eq', field: 'featureIds', value: id });
  const range = (field: string, gte?: number, lte?: number) => {
    if (gte !== undefined || lte !== undefined) filters.push({ op: 'range', field, gte, lte });
  };
  range('priceCents', q.priceMinCents, q.priceMaxCents);
  range('beds', q.bedsMin);
  range('baths', q.bathsMin);
  range('areaM2', q.areaMinM2, q.areaMaxM2);
  if (q.geoBox) filters.push({ op: 'geoBox', ...q.geoBox });
  return filters;
}
