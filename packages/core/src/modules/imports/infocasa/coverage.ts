import { type FieldRule, renderRules } from '../xml-coverage';

/**
 * The Infocasa XML export field map (S6-07, [H14]). ASSUMED: no public specification was found. The shape is that
 * of a Spanish portal/CRM export (`<propiedades><propiedad id="...">`, language-keyed text like Kyero); the element
 * names are to be confirmed against a real Infocasa export at H14 (listed in STATUS). Paths are relative to
 * `<propiedad>`; `*` is a language code (`descripcion/es`).
 */
export const INFOCASA_FIELDS: readonly FieldRule[] = [
  { path: '@id', maps: 'ref', note: 'The Infocasa code: the re-import key.' },
  {
    path: '@actualizado',
    maps: null,
    note: 'Feed-side change time; unchanged content is detected by the import hash.',
  },
  {
    path: 'accion',
    maps: 'transactionType, pricePeriod',
    note: 'V: SALE. A: RENT_LONG_TERM per MONTH. T: RENT_SHORT_TERM.',
  },
  { path: 'situacion', maps: 'status', note: 'vendido: SOLD. alquilado: RENTED. reservado: UNDER_OFFER. Else ACTIVE.' },
  { path: 'tipo_inmueble', maps: 'propertyType', note: 'Free text, resolved by the taxonomy resolver.' },
  { path: 'pais', maps: 'location.country', note: 'Else the connection setting defaultCountry (Spain).' },
  { path: 'provincia', maps: 'location.region', note: 'Resolved under the country.' },
  { path: 'municipio', maps: 'location.city', note: 'Resolved under the province.' },
  { path: 'barrio', maps: 'location.area', note: 'Resolved under the town.' },
  { path: 'direccion', maps: null, note: 'The street address is never imported (the pin is approximate).' },
  { path: 'lat', maps: 'coordinates.lat', note: 'Decimal degrees; 0,0 is no point.' },
  { path: 'lon', maps: 'coordinates.lng', note: 'Decimal degrees. Precision stays APPROX.' },
  {
    path: 'precio',
    maps: 'priceCents, priceOnRequest',
    note: 'Spanish notation allowed (1.250.000,50); missing or 0 is price on request.',
  },
  { path: 'precio@moneda', maps: 'currency', note: 'ISO 4217 code; EUR when absent.' },
  { path: 'precio@periodo', maps: 'pricePeriod', note: 'Short-term rent: noche is NIGHT, anything else WEEK.' },
  { path: 'dormitorios', maps: 'bedrooms', note: 'Integer.' },
  { path: 'aseos', maps: 'bathrooms', note: 'Integer.' },
  { path: 'superficie_construida', maps: 'builtM2', note: 'Square metres; 0 is no value.' },
  { path: 'superficie_parcela', maps: 'plotM2', note: 'Square metres; 0 is no value.' },
  { path: 'superficie_terraza', maps: 'terraceM2', note: 'Square metres; 0 is no value.' },
  { path: 'ano_construccion', maps: 'yearBuilt', note: 'Four-digit year.' },
  { path: 'calificacion_energetica', maps: 'energyRating', note: 'A-G, exento or en tramite.' },
  { path: 'emisiones_co2', maps: 'energyEmissionsRating', note: 'A-G, exento or en tramite.' },
  { path: 'extras', maps: 'features', note: 'Container.' },
  { path: 'extras/extra', maps: 'features', note: 'One feature per element, resolved by the taxonomy resolver.' },
  { path: 'titulo', maps: 'translations', note: 'Container of one title per language.' },
  { path: 'titulo/*', maps: 'translations[].title', note: 'The locale is the element name.' },
  { path: 'descripcion', maps: 'translations', note: 'Container of one description per language.' },
  {
    path: 'descripcion/*',
    maps: 'translations[].description',
    note: 'HTML reduced to plain text; the locale is the element name.',
  },
  { path: 'fotos', maps: 'images', note: 'Container.' },
  { path: 'fotos/foto', maps: 'images[]', note: 'http(s) only; feed order kept.' },
  { path: 'video_url', maps: null, note: 'Video links are not imported.' },
  { path: 'contacto', maps: null, note: 'Owner or agent contact is never imported (white-label rule).' },
  { path: 'contacto/nombre', maps: null, note: 'Contact is never imported.' },
  { path: 'contacto/telefono', maps: null, note: 'Contact is never imported.' },
  { path: 'observaciones_privadas', maps: null, note: 'Internal notes are never imported (white-label rule).' },
];

export const renderInfocasaCoverageReport = () => renderRules('Infocasa', INFOCASA_FIELDS);
