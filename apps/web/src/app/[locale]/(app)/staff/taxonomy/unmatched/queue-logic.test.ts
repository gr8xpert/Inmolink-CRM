import type { StaffTaxonomyDto, UnmatchedDto } from '@inmolink/contracts';
import { CreateCatalogItemInput } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import {
  appendPage,
  catalogGroups,
  catalogOptions,
  childNodes,
  filterOptions,
  locationLabel,
  newCatalogItem,
  OPTION_CAP,
  parseQueueKind,
  rootLocationNodes,
  translatedName,
} from './queue-logic';

const id = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, name: string, level: 'COUNTRY' | 'REGION' | 'CITY' | 'AREA', childCount = 0) => ({
  id: id(n),
  name,
  level,
  childCount,
  code: null,
  slug: name.toLowerCase(),
});

const tree: StaffTaxonomyDto = {
  locale: 'es',
  locations: [{ ...node(1, 'España', 'COUNTRY', 1), children: [node(2, 'Málaga', 'REGION', 100)] }],
  locationGroups: [],
  propertyTypes: [
    {
      id: id(10),
      key: 'houses',
      name: 'Houses',
      slug: 'houses',
      types: [{ id: id(11), key: 'villa', name: 'Villa', slug: 'villa' }],
    },
  ],
  features: [
    {
      id: id(20),
      key: 'outdoor',
      name: 'Outdoor',
      slug: 'outdoor',
      features: [{ id: id(21), key: 'pool', name: 'Pool', slug: 'pool', icon: 'waves' }],
    },
  ],
};

describe('mapping queue logic', () => {
  it('[S17-F22] filters options by every word typed, ignoring accents and case', () => {
    const options = [
      { id: 'a', label: 'España › Málaga › Marbella' },
      { id: 'b', label: 'España › Cádiz › Marbella del Mar' },
      { id: 'c', label: 'España › Málaga' },
    ];
    expect(filterOptions(options, 'malaga marb').shown.map((o) => o.id)).toEqual(['a']);
    expect(filterOptions(options, '  CÁDIZ ').shown.map((o) => o.id)).toEqual(['b']);
    expect(filterOptions(options, '').shown).toHaveLength(3);
    expect(filterOptions(options, 'nowhere').shown).toEqual([]);
  });

  it('[S17-F22] caps a long list and says how many stay hidden', () => {
    const options = Array.from({ length: OPTION_CAP + 7 }, (_, i) => ({ id: String(i), label: `City ${i}` }));
    const { shown, hidden } = filterOptions(options, 'city');
    expect(shown).toHaveLength(OPTION_CAP);
    expect(hidden).toBe(7);
  });

  it('[S17-F22] location labels carry the whole path, since names repeat', () => {
    const roots = rootLocationNodes(tree.locations);
    expect(roots.map(locationLabel)).toEqual(['España', 'España › Málaga']);
    const region = roots[1];
    if (!region) throw new Error('no region');
    const [city] = childNodes(region, [{ id: id(3), name: 'Marbella', level: 'CITY', childCount: 2 }]);
    if (!city) throw new Error('no city');
    expect(locationLabel(city)).toBe('España › Málaga › Marbella');
    const [area] = childNodes(city, [{ id: id(4), name: 'San Pedro', level: 'AREA', childCount: 0 }]);
    if (!area) throw new Error('no area');
    expect(locationLabel(area)).toBe('España › Málaga › Marbella › San Pedro');
  });

  it('[S17-F22] names a location in the page language, else the default, else any', () => {
    const ts = [
      { locale: 'nl', name: 'Spanje' },
      { locale: 'es', name: 'España' },
    ];
    expect(translatedName(ts, 'nl', 'es')).toBe('Spanje');
    expect(translatedName(ts, 'en', 'es')).toBe('España');
    expect(translatedName(ts, 'en', 'de')).toBe('Spanje');
    expect(translatedName([], 'en', 'es')).toBe('');
  });

  it('[S17-F22] catalog options show their group, per kind', () => {
    expect(catalogOptions(catalogGroups(tree, 'propertyType'))).toEqual([{ id: id(11), label: 'Houses › Villa' }]);
    expect(catalogOptions(catalogGroups(tree, 'feature'))).toEqual([{ id: id(21), label: 'Outdoor › Pool' }]);
  });

  it('[S17-F22] create new: the feed value is the name, its slug the key, and the contract accepts it', () => {
    const input = newCatalogItem('feature', id(20), ' Private Pool (Heated) ', 'en');
    expect(input).toEqual({
      kind: 'feature',
      groupId: id(20),
      translations: [{ locale: 'en', name: 'Private Pool (Heated)', slug: 'private-pool-heated' }],
    });
    expect(CreateCatalogItemInput.safeParse(input).success).toBe(true);
  });

  it('[S17-F22] create new: a long value still gives a valid slug; one without Latin letters gives none', () => {
    const input = newCatalogItem('propertyType', id(10), `${'a'.repeat(119)} b c`, 'en');
    expect(input?.translations[0]?.slug).toBe('a'.repeat(119));
    expect(CreateCatalogItemInput.safeParse(input).success).toBe(true);
    expect(newCatalogItem('feature', id(20), 'Ελλάδα', 'en')).toBeNull();
  });

  it('[S17-F22] the next page never repeats a row on screen', () => {
    const row = (n: number) => ({ id: id(n) }) as UnmatchedDto;
    expect(appendPage([row(1), row(2)], [row(2), row(3)]).map((r) => r.id)).toEqual([id(1), id(2), id(3)]);
  });

  it('[S17-F22] an unknown tab falls back to the first kind', () => {
    expect(parseQueueKind('feature')).toBe('feature');
    expect(parseQueueKind('location')).toBe('location');
    expect(parseQueueKind('nonsense')).toBe('propertyType');
    expect(parseQueueKind(undefined)).toBe('propertyType');
  });
});
