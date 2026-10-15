import type { TaxonomyDto } from '@inmolink/contracts';

export interface Option {
  id: string;
  label: string;
}
export interface OptionGroup {
  label: string;
  options: Option[];
}

/** The taxonomy as the listing forms use it: grouped selects and id → name lookups. */
export interface ListingTaxonomy {
  propertyTypes: OptionGroup[];
  /** Every location with its path ("Spain › Málaga › Marbella"), countries first, in tree order. */
  locations: Option[];
  features: OptionGroup[];
  typeName: (id: string) => string | null;
  locationName: (id: string) => string | null;
}

export function listingTaxonomy(tax: TaxonomyDto | null): ListingTaxonomy {
  const propertyTypes: OptionGroup[] = (tax?.propertyTypes ?? []).map((g) => ({
    label: g.name,
    options: g.types.map((t) => ({ id: t.id, label: t.name })),
  }));
  const features: OptionGroup[] = (tax?.features ?? []).map((g) => ({
    label: g.name,
    options: g.features.map((f) => ({ id: f.id, label: f.name })),
  }));
  const locations: Option[] = [];
  const walk = (nodes: { id: string; name: string; children?: unknown[] }[], path: string[]) => {
    for (const n of nodes) {
      const here = [...path, n.name];
      locations.push({ id: n.id, label: here.join(' › ') });
      if (n.children) walk(n.children as typeof nodes, here);
    }
  };
  walk(tax?.locations ?? [], []);
  const types = new Map(propertyTypes.flatMap((g) => g.options.map((o) => [o.id, o.label] as const)));
  const places = new Map(locations.map((o) => [o.id, o.label] as const));
  return {
    propertyTypes,
    locations,
    features,
    typeName: (id) => types.get(id) ?? null,
    locationName: (id) => places.get(id) ?? null,
  };
}
