import { type FieldRule, renderRules } from '../xml-coverage';

/**
 * The thinkSPAIN XML import field map (S6-07, [H14]). ASSUMED: thinkSPAIN's agent feed specification is not public.
 * The shape is an English-language portal feed (`<thinkspain><property>`, per-language `title` / `description`
 * elements carrying a `lang` attribute); the element names are to be confirmed against a real thinkSPAIN sample at
 * H14 (listed in STATUS). Paths are relative to `<property>`.
 */
export const THINKSPAIN_FIELDS: readonly FieldRule[] = [
  { path: 'reference', maps: 'ref', note: 'The agent reference: the re-import key.' },
  {
    path: 'last_updated',
    maps: null,
    note: 'Feed-side change time; unchanged content is detected by the import hash.',
  },
  { path: 'url', maps: null, note: 'The source agency page: Inmolink does not link to the feed owner.' },
  { path: 'new_build', maps: null, note: 'Condition is not modelled on listings.' },
  {
    path: 'listing_type',
    maps: 'transactionType, pricePeriod',
    note: 'sale: SALE. rent: RENT_LONG_TERM per MONTH. holiday_rent: RENT_SHORT_TERM.',
  },
  { path: 'status', maps: 'status', note: 'sold: SOLD. rented: RENTED. reserved: UNDER_OFFER. Else ACTIVE.' },
  { path: 'type', maps: 'propertyType', note: 'Free text, resolved by the taxonomy resolver.' },
  { path: 'country', maps: 'location.country', note: 'Else the connection setting defaultCountry (Spain).' },
  { path: 'region', maps: null, note: 'Coarse label (Costa del Sol); the chain comes from province, town and area.' },
  { path: 'province', maps: 'location.region', note: 'Resolved under the country.' },
  { path: 'town', maps: 'location.city', note: 'Resolved under the province.' },
  { path: 'area', maps: 'location.area', note: 'Resolved under the town.' },
  { path: 'address', maps: null, note: 'The street address is never imported (the pin is approximate).' },
  { path: 'latitude', maps: 'coordinates.lat', note: 'Decimal degrees; 0,0 is no point.' },
  { path: 'longitude', maps: 'coordinates.lng', note: 'Decimal degrees. Precision stays APPROX.' },
  {
    path: 'price',
    maps: 'priceCents, priceOnRequest',
    note: 'Decimal in the currency; missing or 0 is price on request.',
  },
  { path: 'currency', maps: 'currency', note: 'ISO 4217 code; EUR when absent.' },
  { path: 'price_period', maps: 'pricePeriod', note: 'Holiday rent: night is NIGHT, anything else WEEK.' },
  { path: 'bedrooms', maps: 'bedrooms', note: 'Integer.' },
  { path: 'bathrooms', maps: 'bathrooms', note: 'Integer.' },
  { path: 'built_size', maps: 'builtM2', note: 'Square metres; 0 is no value.' },
  { path: 'plot_size', maps: 'plotM2', note: 'Square metres; 0 is no value.' },
  { path: 'terrace_size', maps: 'terraceM2', note: 'Square metres; 0 is no value.' },
  { path: 'year_built', maps: 'yearBuilt', note: 'Four-digit year.' },
  { path: 'energy_class', maps: 'energyRating', note: 'A-G, exempt or in_progress.' },
  { path: 'emissions_class', maps: 'energyEmissionsRating', note: 'A-G, exempt or in_progress.' },
  { path: 'features', maps: 'features', note: 'Container.' },
  { path: 'features/feature', maps: 'features', note: 'One feature per element, resolved by the taxonomy resolver.' },
  { path: 'title', maps: 'translations[].title', note: 'One element per language (lang attribute).' },
  { path: 'title@lang', maps: 'translations[].locale', note: 'Two-letter language code.' },
  { path: 'description', maps: 'translations[].description', note: 'HTML reduced to plain text.' },
  { path: 'description@lang', maps: 'translations[].locale', note: 'Two-letter language code.' },
  { path: 'photos', maps: 'images', note: 'Container.' },
  { path: 'photos/photo', maps: 'images[]', note: 'http(s) only; feed order kept.' },
  { path: 'agent', maps: null, note: 'Agent contact is never imported (white-label rule).' },
  { path: 'agent/name', maps: null, note: 'Contact is never imported.' },
  { path: 'agent/email', maps: null, note: 'Contact is never imported.' },
  { path: 'agent/phone', maps: null, note: 'Contact is never imported.' },
];

export const renderThinkSpainCoverageReport = () => renderRules('thinkSPAIN', THINKSPAIN_FIELDS);
