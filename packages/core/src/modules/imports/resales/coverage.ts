/**
 * The Resales Online V6 field map (S6-06): every property field of the recorded response shape with the
 * `FeedListing` field it feeds, or why it is ignored. A test walks the fixture pages against it, so a new field in
 * a recorded response gets a row here or fails the test. Paths are relative to one `Property` record; `[]` is a list.
 */
export interface ResalesFieldRule {
  path: string;
  maps: string | null;
  note: string;
}

export const RESALES_V6_FIELDS: readonly ResalesFieldRule[] = [
  { path: 'Reference', maps: 'ref', note: 'The Resales Online reference: the re-import key.' },
  { path: 'AgencyRef', maps: null, note: 'The agent own reference; not stored.' },
  {
    path: 'AgencyId',
    maps: null,
    note: 'Ownership check only: must equal the connection agency id, else the record is dropped.',
  },
  { path: 'Country', maps: 'location.country', note: 'Defaults to Spain.' },
  { path: 'Province', maps: 'location.region', note: 'Resolved by the loader.' },
  {
    path: 'Area',
    maps: null,
    note: 'Coarse region label (Costa del Sol); the chain comes from Province/Location/SubLocation.',
  },
  { path: 'Location', maps: 'location.city', note: 'Town.' },
  { path: 'SubLocation', maps: 'location.area', note: 'Resolved by the loader; unmatched values are queued.' },
  { path: 'PropertyType', maps: null, note: 'Container.' },
  { path: 'PropertyType.Type', maps: 'propertyType', note: 'Resolved by the loader.' },
  { path: 'PropertyType.NameType', maps: 'propertyType', note: 'Fallback for Type.' },
  { path: 'PropertyType.TypeId', maps: null, note: 'Resales internal id.' },
  { path: 'PropertyType.Subtype1', maps: null, note: 'Subtype; the loader resolves the main type only.' },
  { path: 'Status', maps: null, note: 'Container.' },
  { path: 'Status.system', maps: 'import gate', note: 'Only "Available" imports; others fail with NOT_AVAILABLE.' },
  { path: 'Bedrooms', maps: 'bedrooms', note: '' },
  { path: 'Bathrooms', maps: 'bathrooms', note: '' },
  { path: 'Currency', maps: 'currency', note: 'Defaults to EUR.' },
  { path: 'Price', maps: 'priceCents', note: 'Decimal without separators; zero means price on request.' },
  { path: 'OriginalPrice', maps: null, note: 'Previous price; history is kept by the listing itself.' },
  { path: 'Built', maps: 'builtM2', note: '' },
  { path: 'GardenPlot', maps: 'plotM2', note: '' },
  { path: 'Terrace', maps: null, note: 'Terrace area; no field in the draft.' },
  { path: 'Pool', maps: 'features', note: '1 adds the feature "Pool".' },
  { path: 'Parking', maps: null, note: 'Flag; covered by the feature categories.' },
  { path: 'Garden', maps: null, note: 'Flag; covered by the feature categories.' },
  { path: 'Latitude', maps: 'coordinates', note: 'Zero/zero and out-of-range are ignored.' },
  { path: 'Longitude', maps: 'coordinates', note: '' },
  {
    path: 'Description',
    maps: 'translations.description',
    note: 'One language (the request language); HTML reduced to text.',
  },
  { path: 'MainImage', maps: 'images', note: 'Used only when Pictures is empty.' },
  { path: 'PropertyFeatures', maps: null, note: 'Container.' },
  { path: 'PropertyFeatures.Category', maps: null, note: 'Container.' },
  { path: 'PropertyFeatures.Category[]', maps: null, note: 'Container.' },
  { path: 'PropertyFeatures.Category[].Type', maps: null, note: 'Category name; not stored.' },
  { path: 'PropertyFeatures.Category[].Value', maps: 'features', note: 'Each value a feature, deduplicated.' },
  { path: 'PropertyFeatures.Category[].Value[]', maps: 'features', note: 'Each value.' },
  { path: 'Pictures', maps: null, note: 'Container.' },
  { path: 'Pictures.Count', maps: null, note: '' },
  { path: 'Pictures.Picture', maps: null, note: 'Container.' },
  { path: 'Pictures.Picture[]', maps: null, note: 'Container.' },
  { path: 'Pictures.Picture[].Id', maps: null, note: '' },
  { path: 'Pictures.Picture[].PictureURL', maps: 'images', note: 'http(s) only, capped per listing.' },
];

/** Every field path of a record (arrays flattened as `[]`). */
export function fieldPaths(record: unknown, prefix = ''): string[] {
  if (Array.isArray(record)) return record.flatMap((v) => [`${prefix}[]`, ...fieldPaths(v, `${prefix}[]`)]);
  if (record && typeof record === 'object')
    return Object.entries(record).flatMap(([k, v]) => {
      const p = prefix ? `${prefix}.${k}` : k;
      return [p, ...fieldPaths(v, p)];
    });
  return [];
}

const known = new Set(RESALES_V6_FIELDS.map((f) => f.path));
export const unaccountedPaths = (record: unknown): string[] =>
  [...new Set(fieldPaths(record))].filter((p) => !known.has(p));
