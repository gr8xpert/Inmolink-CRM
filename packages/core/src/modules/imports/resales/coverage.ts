/**
 * The Resales Online V6 field map (S6-06, reworked in S6-F4 to the shapes of the SPW project's production adapter):
 * every field of a `SearchProperties` record and of a `PropertyDetails` record, with the `FeedListing` field it feeds
 * or why it is ignored. A test walks the fixtures against it, so a new field in a recorded response gets a row here or
 * fails the test. Paths are relative to one `Property` record; `[]` is a list (a single object counts as a list of one).
 */
export interface ResalesFieldRule {
  path: string;
  maps: string | null;
  note: string;
}

/** Follow-up S7-F12: fields with no `FeedListing` field yet (fees, IBI, development name, key-ready, price list). */
const NO_FIELD_YET = 'Details only; no FeedListing field yet (S7-F12).';

export const RESALES_V6_FIELDS: readonly ResalesFieldRule[] = [
  { path: 'Reference', maps: 'ref', note: 'The Resales Online reference: the re-import key.' },
  { path: 'AgencyRef', maps: null, note: 'The agent own reference; not stored.' },
  {
    path: 'OwnProperty',
    maps: 'import gate',
    note: '"1" = the agency own listing; anything else (or absent) is dropped as NOT_OWN_LISTING. Also read as Own / IsOwnProperty. Confirm on a live response (H13).',
  },
  { path: 'Country', maps: 'location.country', note: 'Defaults to Spain.' },
  { path: 'Province', maps: 'location.region', note: 'Resolved by the loader.' },
  {
    path: 'Area',
    maps: null,
    note: 'Coastal region (Costa del Sol), spans provinces; no level of the location tree.',
  },
  { path: 'Location', maps: 'location.city', note: 'List: the town or district. Details: a container (below).' },
  { path: 'Location.LocationName', maps: 'location.city', note: 'Details form of Location.' },
  { path: 'Location.Province', maps: 'location.region', note: 'Details form of Province.' },
  { path: 'Location.Area', maps: null, note: 'Details form of Area.' },
  { path: 'Location.SubLocation', maps: 'location.area', note: 'Details form of SubLocation.' },
  { path: 'Location.Country', maps: 'location.country', note: 'Details form of Country.' },
  { path: 'Location.LocationId', maps: null, note: 'Resales internal id.' },
  {
    path: 'SubLocation',
    maps: 'location.area',
    note: 'Urbanisation; left out when equal to the town. Resolved by the loader.',
  },
  { path: 'PropertyType', maps: null, note: 'Container.' },
  {
    path: 'PropertyType.NameType',
    maps: 'propertyType',
    note: 'The subtype ("Detached Villa"); on a development it says "New Development" and Subtype1 is used.',
  },
  { path: 'PropertyType.Type', maps: 'propertyType', note: 'Group ("House"); last fallback.' },
  { path: 'PropertyType.TypeId', maps: null, note: 'Resales internal id.' },
  {
    path: 'PropertyType.Subtype1',
    maps: 'propertyType',
    note: 'The type of a development (and fallback for NameType).',
  },
  { path: 'PropertyType.SubtypeId1', maps: null, note: 'Resales internal id.' },
  { path: 'Status', maps: null, note: 'Container (or a plain string).' },
  {
    path: 'Status.system',
    maps: 'status',
    note: 'Sold / Off Market / Rented: not imported (withdrawn as missing); Under Offer / Reserved: UNDER_OFFER.',
  },
  { path: 'Status.en', maps: 'status', note: 'Read before Status.system (SPW).' },
  { path: 'Bedrooms', maps: 'bedrooms', note: '"3" or a range "1 - 3" (the low end).' },
  { path: 'Bathrooms', maps: 'bathrooms', note: '"2.5" (P_DecimalBaths) counts as 2; a range gives its low end.' },
  { path: 'Currency', maps: 'currency', note: 'Defaults to EUR.' },
  {
    path: 'Price',
    maps: 'priceCents',
    note: 'Thousands commas stripped; a range gives its low end; POA or zero means price on request.',
  },
  { path: 'OriginalPrice', maps: null, note: 'Previous price; history is kept by the listing itself.' },
  { path: 'Built', maps: 'builtM2', note: 'Range: the low end.' },
  { path: 'BuiltArea', maps: 'builtM2', note: 'Fallback for Built.' },
  { path: 'GardenPlot', maps: 'plotM2', note: 'Zero is no plot.' },
  { path: 'Plot', maps: 'plotM2', note: 'Fallback for GardenPlot.' },
  { path: 'Terrace', maps: 'terraceM2', note: 'Range: the low end.' },
  { path: 'Pool', maps: 'features', note: '1 adds the feature "Pool".' },
  { path: 'Parking', maps: null, note: 'Flag; covered by the feature categories.' },
  { path: 'Garden', maps: null, note: 'Flag (not a size); covered by the feature categories.' },
  {
    path: 'GpsX',
    maps: 'coordinates',
    note: 'Details (P_ShowGPSCoords); X/Y order told apart by Spain latitudes 27-44.',
  },
  { path: 'GpsY', maps: 'coordinates', note: 'See GpsX.' },
  { path: 'GPS_Latitude', maps: 'coordinates', note: 'Details; zero/zero and out-of-range are ignored.' },
  { path: 'GPS_Longitude', maps: 'coordinates', note: '' },
  {
    path: 'Description',
    maps: 'translations.description',
    note: 'English (no P_Lang); other languages from one SearchProperties call per language; text equal to the English is left out. HTML reduced to text.',
  },
  { path: 'MainImage', maps: 'images', note: 'Used only when Pictures is empty.' },
  { path: 'PropertyFeatures', maps: null, note: 'Container.' },
  { path: 'PropertyFeatures.Category', maps: null, note: 'Container.' },
  { path: 'PropertyFeatures.Category[]', maps: null, note: 'Container.' },
  {
    path: 'PropertyFeatures.Category[].Type',
    maps: null,
    note: 'Category name; "Category" + "New Development" marks a development.',
  },
  {
    path: 'PropertyFeatures.Category[].Value',
    maps: 'features',
    note: 'A value or a list; each a feature, deduplicated.',
  },
  { path: 'PropertyFeatures.Category[].Value[]', maps: 'features', note: 'Each value.' },
  { path: 'Pictures', maps: null, note: 'Container.' },
  { path: 'Pictures.Count', maps: null, note: '' },
  { path: 'Pictures.Picture', maps: null, note: 'Container.' },
  { path: 'Pictures.Picture[]', maps: null, note: 'Container.' },
  { path: 'Pictures.Picture[].Id', maps: null, note: '' },
  { path: 'Pictures.Picture[].PictureURL', maps: 'images', note: 'http(s) only, capped per listing.' },
  { path: 'Pictures.Picture[].PictureCaption', maps: null, note: 'No caption field in the draft.' },
  { path: 'BuiltYear', maps: 'yearBuilt', note: 'Details only.' },
  { path: 'EnergyRating', maps: 'energyRating', note: 'Details; A-G, "InProgress" ignored.' },
  { path: 'Community_Fees_Year', maps: null, note: `Yearly. ${NO_FIELD_YET}` },
  { path: 'IBI_Fees_Year', maps: null, note: `Yearly. ${NO_FIELD_YET}` },
  { path: 'Basura_Tax_Year', maps: null, note: `Yearly. ${NO_FIELD_YET}` },
  { path: 'NewDevName', maps: null, note: NO_FIELD_YET },
  { path: 'KeyReady', maps: null, note: `Non-empty marks a development. ${NO_FIELD_YET}` },
  { path: 'PriceList', maps: null, note: `Development units (p_pricelist). ${NO_FIELD_YET}` },
  { path: 'PriceList[]', maps: null, note: NO_FIELD_YET },
  ...['Name', 'Type', 'Price', 'BuiltSize', 'Terrace', 'Beds', 'Baths', 'KeyReady', 'StatusText', 'StatusCode'].map(
    (f) => ({ path: `PriceList[].${f}`, maps: null, note: NO_FIELD_YET }),
  ),
];

/** Containers Resales sends as a list or, with one entry, as a single object. */
const LIST_OR_ONE = new Set(['PropertyFeatures.Category', 'Pictures.Picture', 'PriceList']);

/** Every field path of a record (arrays flattened as `[]`). */
export function fieldPaths(record: unknown, prefix = ''): string[] {
  if (Array.isArray(record)) return record.flatMap((v) => [`${prefix}[]`, ...fieldPaths(v, `${prefix}[]`)]);
  if (record && typeof record === 'object') {
    if (LIST_OR_ONE.has(prefix)) return fieldPaths([record], prefix);
    return Object.entries(record).flatMap(([k, v]) => {
      const p = prefix ? `${prefix}.${k}` : k;
      return [p, ...fieldPaths(v, p)];
    });
  }
  return [];
}

const known = new Set(RESALES_V6_FIELDS.map((f) => f.path));
export const unaccountedPaths = (record: unknown): string[] =>
  [...new Set(fieldPaths(record))].filter((p) => !known.has(p));
