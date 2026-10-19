import { type FieldRule, renderRules } from '../xml-coverage';

/**
 * The Milenio+ XML export field map (S6-07, [H14]). ASSUMED: no public specification exists. The shape is that of a
 * Spanish-language CRM export (`<inmuebles><inmueble>`), built from what Spanish CRM exports have in common; the
 * element names are to be confirmed against a real Milenio+ export at H14 (listed in STATUS). Paths are relative to
 * `<inmueble>`. Owner contact, commission and internal notes are ignored on purpose (never imported).
 */
export const MILENIO_FIELDS: readonly FieldRule[] = [
  { path: 'referencia', maps: 'ref', note: 'The CRM reference: the re-import key.' },
  { path: 'ref_agencia', maps: null, note: 'The agent own reference; not stored.' },
  { path: 'fecha_alta', maps: null, note: 'Feed-side time; unchanged content is detected by the import hash.' },
  { path: 'fecha_modificacion', maps: null, note: 'Feed-side time; unchanged content is detected by the import hash.' },
  {
    path: 'operacion',
    maps: 'transactionType, pricePeriod',
    note: 'Venta: SALE. Alquiler: RENT_LONG_TERM per MONTH. Alquiler vacacional or de temporada: RENT_SHORT_TERM.',
  },
  { path: 'estado', maps: 'status', note: 'Vendido: SOLD. Alquilado: RENTED. Reservado: UNDER_OFFER. Else ACTIVE.' },
  { path: 'tipo', maps: 'propertyType', note: 'Free text, resolved by the taxonomy resolver.' },
  { path: 'subtipo', maps: null, note: 'The type is what is resolved; sub-types are not modelled.' },
  { path: 'pais', maps: 'location.country', note: 'Else the connection setting defaultCountry (Spain).' },
  { path: 'provincia', maps: 'location.region', note: 'Resolved under the country.' },
  { path: 'localidad', maps: 'location.city', note: 'Resolved under the province.' },
  { path: 'zona', maps: 'location.area', note: 'Resolved under the town.' },
  { path: 'codigo_postal', maps: null, note: 'Not modelled; the town and area locate the listing.' },
  { path: 'direccion', maps: null, note: 'The street address is never imported (the pin is approximate).' },
  { path: 'latitud', maps: 'coordinates.lat', note: 'Decimal degrees (point or comma); 0,0 is no point.' },
  { path: 'longitud', maps: 'coordinates.lng', note: 'Decimal degrees (point or comma). Precision stays APPROX.' },
  {
    path: 'precio',
    maps: 'priceCents, priceOnRequest',
    note: 'Spanish notation allowed (1.250.000,50); missing or 0 means price on request.',
  },
  { path: 'moneda', maps: 'currency', note: 'ISO 4217 code; EUR when absent.' },
  { path: 'periodo', maps: 'pricePeriod', note: 'Short-term rent: noche is NIGHT, anything else WEEK.' },
  { path: 'habitaciones', maps: 'bedrooms', note: 'Integer.' },
  { path: 'banos', maps: 'bathrooms', note: 'Integer.' },
  { path: 'm2_construidos', maps: 'builtM2', note: 'Square metres; 0 is no value.' },
  { path: 'm2_parcela', maps: 'plotM2', note: 'Square metres; 0 is no value.' },
  { path: 'm2_terraza', maps: 'terraceM2', note: 'Square metres; 0 is no value.' },
  { path: 'anio_construccion', maps: 'yearBuilt', note: 'Four-digit year.' },
  { path: 'certificacion_energetica', maps: 'energyRating, energyEmissionsRating', note: 'Container.' },
  { path: 'certificacion_energetica/consumo', maps: 'energyRating', note: 'A-G, exento or en tramite.' },
  { path: 'certificacion_energetica/emisiones', maps: 'energyEmissionsRating', note: 'A-G, exento or en tramite.' },
  { path: 'caracteristicas', maps: 'features', note: 'Container.' },
  {
    path: 'caracteristicas/caracteristica',
    maps: 'features',
    note: 'One feature per element, resolved by the taxonomy resolver.',
  },
  { path: 'titulos', maps: 'translations', note: 'Container.' },
  { path: 'titulos/titulo', maps: 'translations[].title', note: 'Per language (idioma attribute).' },
  { path: 'titulos/titulo@idioma', maps: 'translations[].locale', note: 'Two-letter language code.' },
  { path: 'descripciones', maps: 'translations', note: 'Container.' },
  { path: 'descripciones/descripcion', maps: 'translations[].description', note: 'HTML reduced to plain text.' },
  { path: 'descripciones/descripcion@idioma', maps: 'translations[].locale', note: 'Two-letter language code.' },
  { path: 'fotos', maps: 'images', note: 'Container.' },
  { path: 'fotos/foto', maps: 'images[]', note: 'http(s) only; order by the orden attribute, else feed order.' },
  { path: 'fotos/foto@orden', maps: 'images order', note: 'Position of the photo; sorted ascending.' },
  { path: 'video', maps: null, note: 'Video links are not imported.' },
  { path: 'propietario', maps: null, note: 'Owner contact is never imported (white-label rule).' },
  { path: 'propietario/nombre', maps: null, note: 'Owner contact is never imported.' },
  { path: 'propietario/telefono', maps: null, note: 'Owner contact is never imported.' },
  { path: 'comision', maps: null, note: 'Commission is never imported (white-label rule).' },
  { path: 'notas_internas', maps: null, note: 'Internal notes are never imported (white-label rule).' },
];

export const renderMilenioCoverageReport = () => renderRules('Milenio+', MILENIO_FIELDS);
