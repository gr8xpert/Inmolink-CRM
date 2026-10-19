import type { MapperPathDto } from '@inmolink/contracts';

/**
 * A first guess of the mapping from the names in the sample (S6-04): per field, the path whose last segment is a
 * well-known word for it (English, Spanish, German, French, Italian, Portuguese, Dutch). Only a hint — the mapper
 * shows it as a starting point the admin confirms, and values are never mapped by it without being shown.
 */
const WORDS: Record<string, readonly string[]> = {
  ref: ['id', 'ref', 'reference', 'referencia', 'referenz', 'code', 'codigo', 'objectid', 'propertyid', 'listingid'],
  propertyType: ['type', 'propertytype', 'tipo', 'tipologia', 'typ', 'objektart', 'category', 'categoria', 'kategorie'],
  price: ['price', 'precio', 'preis', 'prix', 'prezzo', 'preco', 'prijs', 'amount'],
  currency: ['currency', 'moneda', 'waehrung', 'devise', 'valuta', 'moeda'],
  bedrooms: ['beds', 'bedrooms', 'bed', 'dormitorios', 'habitaciones', 'schlafzimmer', 'chambres', 'camere', 'quartos'],
  bathrooms: ['baths', 'bathrooms', 'bath', 'banos', 'badezimmer', 'bad', 'salles', 'bagni', 'casasdebanho'],
  builtM2: ['built', 'builtarea', 'living', 'livingarea', 'constructed', 'construido', 'wohnflaeche', 'surface'],
  plotM2: ['plot', 'plotarea', 'parcela', 'grundstueck', 'terrain', 'land'],
  terraceM2: ['terrace', 'terraza', 'terrasse', 'terraco'],
  yearBuilt: ['yearbuilt', 'year', 'anoconstruccion', 'baujahr'],
  latitude: ['latitude', 'lat', 'latitud'],
  longitude: ['longitude', 'lng', 'lon', 'long', 'longitud'],
  country: ['country', 'pais', 'land', 'pays', 'paese'],
  region: ['region', 'province', 'provincia', 'state', 'bundesland'],
  city: ['city', 'town', 'ciudad', 'poblacion', 'municipio', 'stadt', 'ort', 'ville', 'citta', 'cidade'],
  area: ['area', 'zone', 'zona', 'district', 'barrio', 'urbanizacion', 'location_detail', 'stadtteil'],
  energyRating: ['energyrating', 'energy', 'cee', 'epc', 'energieklasse'],
  features: ['feature', 'features', 'amenity', 'amenities', 'caracteristicas', 'extras', 'tag', 'tags', 'ausstattung'],
  images: [
    'image',
    'images',
    'photo',
    'photos',
    'foto',
    'fotos',
    'picture',
    'pictures',
    'img',
    'url',
    'bild',
    'bilder',
  ],
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_]/g, '');

/** Field → path. Scalar fields take the shallowest matching path with a value in most records. */
export function suggestPaths(paths: readonly MapperPathDto[]): Record<string, string> {
  const out: Record<string, string> = {};
  const total = Math.max(1, ...paths.map((p) => p.count));
  for (const [field, words] of Object.entries(WORDS)) {
    const list = field === 'features' || field === 'images';
    const hits = paths
      .filter((p) => {
        const last = norm(p.path.split('/').at(-1)?.replace(/^@/, '') ?? '');
        if (!words.includes(last)) return false;
        // Lists need a repeated path (or its attribute); scalars a path most records carry and that does not repeat.
        return list ? p.repeated || p.path.includes('/') : !p.repeated && p.count >= total / 2;
      })
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length || b.count - a.count);
    const best = hits[0];
    if (best) out[field] = best.path;
  }
  // A path feeds one field only: the first claim (field order above) wins.
  const claimed = new Set<string>();
  for (const [field, path] of Object.entries(out)) {
    if (field === 'features' || field === 'images') continue;
    if (claimed.has(path)) delete out[field];
    else claimed.add(path);
  }
  return out;
}
