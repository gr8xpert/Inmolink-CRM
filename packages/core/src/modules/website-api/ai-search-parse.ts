/**
 * AI search for websites (S12-08, PLAN §8 #3, port of SPW-AI's `AiSearchService`): the pure half — the model's answer
 * shape, the query normalization its cache keys on, and the mapping of an answer to `/v2/listings` filters.
 *
 * Unlike SPW (which sent each site's whole id lists in the prompt), the model never sees ids: it answers with words
 * from a fixed concept vocabulary (types, features) and place names as written, so the system prompt stays the same
 * for every site (provider prefix caching) and an answer is cached once for every site (the query is the whole
 * input). The concepts and places are then resolved against the cached taxonomy in memory (`searchVocabulary`).
 * As in SPW, the model's reply is untrusted: anything outside the vocabulary or bounds is dropped.
 */

import { createHash } from 'node:crypto';
import { PUBLIC_SEARCH_SORTS, TRANSACTION_TYPES, type WebsiteListingsQuery } from '@inmolink/contracts';
import { z } from 'zod';
import type { SearchVocabulary } from '../taxonomy';

/**
 * Property type concepts → the taxonomy keys / names they may be catalogued under (first hit wins; a type group's
 * name stands for all its types). Keep in sync with `prompts/search-ai/v<N>.md` (a unit test checks it).
 */
export const TYPE_CONCEPTS = {
  apartment: ['apartment', 'apartments', 'flat'],
  penthouse: ['penthouse', 'penthouses'],
  studio: ['studio', 'studios'],
  duplex: ['duplex', 'duplex apartment'],
  'ground-floor-apartment': ['ground floor apartment', 'ground-floor-apartment', 'ground floor'],
  villa: ['villa', 'villas', 'detached villa'],
  townhouse: ['townhouse', 'town house', 'townhouses'],
  'semi-detached': ['semi detached', 'semi-detached', 'semi detached house'],
  bungalow: ['bungalow', 'bungalows'],
  house: ['house', 'houses'],
  finca: ['finca', 'country house', 'cortijo', 'fincas'],
  plot: ['plot', 'land', 'plots', 'building plot'],
  commercial: ['commercial', 'commercial property', 'business premises', 'shop'],
  office: ['office', 'offices'],
  garage: ['garage', 'parking space', 'garages'],
} as const satisfies Record<string, readonly string[]>;

/** Feature concepts → the taxonomy keys / names they may be catalogued under (first hit wins). */
export const FEATURE_CONCEPTS = {
  pool: ['pool', 'swimming pool', 'private pool', 'communal pool'],
  'private-pool': ['private pool', 'private-pool', 'pool private'],
  'communal-pool': ['communal pool', 'communal-pool', 'shared pool'],
  garden: ['garden', 'private garden'],
  terrace: ['terrace', 'terraces', 'balcony'],
  'sea-views': ['sea views', 'sea view', 'sea-views'],
  'mountain-views': ['mountain views', 'mountain view'],
  'golf-views': ['golf views', 'golf view'],
  garage: ['garage', 'private garage'],
  parking: ['parking', 'private parking', 'parking space'],
  'air-conditioning': ['air conditioning', 'air-conditioning', 'aircon'],
  'central-heating': ['central heating', 'heating', 'underfloor heating'],
  lift: ['lift', 'elevator'],
  'gated-community': ['gated community', 'gated'],
  gym: ['gym', 'fitness'],
  beachfront: ['beachfront', 'frontline beach', 'beach front', 'front line beach'],
  'frontline-golf': ['frontline golf', 'golf front', 'front line golf'],
  furnished: ['furnished', 'fully furnished'],
  'storage-room': ['storage room', 'storage'],
  fireplace: ['fireplace'],
  'pets-allowed': ['pets allowed', 'pet friendly'],
  'solar-panels': ['solar panels', 'solar power'],
} as const satisfies Record<string, readonly string[]>;

export type TypeConcept = keyof typeof TYPE_CONCEPTS;
export type FeatureConcept = keyof typeof FEATURE_CONCEPTS;

/**
 * The model's answer (structured output). Every key present (null / [] when the query says nothing), no bounds in
 * the schema itself (provider JSON-schema support varies): `toFilters` applies the bounds.
 */
export const SearchAiAnswer = z.strictObject({
  transaction: z.enum(TRANSACTION_TYPES).nullable(),
  newBuild: z.boolean().nullable(),
  types: z.array(z.string()),
  features: z.array(z.string()),
  places: z.array(z.string()),
  bedsMin: z.number().nullable(),
  bathsMin: z.number().nullable(),
  /** Whole euros (a rental: per month; a holiday rental: per week). */
  priceMin: z.number().nullable(),
  priceMax: z.number().nullable(),
  /** Built area, m². */
  areaMin: z.number().nullable(),
  areaMax: z.number().nullable(),
  reference: z.string().nullable(),
  sort: z.enum(PUBLIC_SEARCH_SORTS).nullable(),
});
export type SearchAiAnswer = z.infer<typeof SearchAiAnswer>;

/** The longest visitor query taken (SPW: 400): a sentence about a home, not a pasted wall of text. */
export const AI_QUERY_MAX = 300;

/**
 * The text the parse is cached by and the model reads (S12-08 review): one key for the many spellings of one
 * sentence. NFKC, lower case, accents of Latin letters folded ("Málaga" = "malaga"), invisible format characters
 * (`\p{Cf}`) dropped, punctuation that carries no meaning replaced by a blank — kept: digits with their `.` / `,`
 * ("1.5m", "300.000 €"), `€`, `%`, `+`, a `-` or `'` inside a word ("CH-1234", "l'alfas"). Blanks collapsed.
 */
export function normalizeAiQuery(q: string): string {
  return q
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\p{Cf}+/gu, '')
    .normalize('NFD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}\s.,€%+'-]+/gu, ' ')
    .replace(/(?<!\p{N})[.,]|[.,](?!\p{N})/gu, ' ')
    .replace(/(?<![\p{L}\p{N}])['-]|['-](?![\p{L}\p{N}])/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, AI_QUERY_MAX)
    .trim();
}

/** Hex SHA-256 of the normalized query (a cache key part). */
export const aiQueryHash = (normalized: string): string => createHash('sha256').update(normalized).digest('hex');

const MAX_PLACES = 5;
const MAX_TERMS = 10;
const PLACE_MAX_CHARS = 80;
const PLACE_RE = /^[\p{L}\p{M}][\p{L}\p{M} '.-]*$/u;
/** Upper bounds a real search never exceeds; beyond them the number is a misreading, dropped. */
const MAX_EUROS = 1_000_000_000;
const MAX_ROOMS = 50;
const MAX_AREA = 1_000_000;
const REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/;

const count = (n: number | null): number | undefined =>
  n !== null && Number.isFinite(n) && n >= 1 && n <= MAX_ROOMS ? Math.floor(n) : undefined;
const euros = (n: number | null): number | undefined =>
  n !== null && Number.isFinite(n) && n > 0 && n <= MAX_EUROS ? Math.round(n) : undefined;
const area = (n: number | null): number | undefined =>
  n !== null && Number.isFinite(n) && n > 0 && n <= MAX_AREA ? Math.round(n) : undefined;

/**
 * Words that state an amount without digits ("medio millón", "eine Million"). Prices and areas are facts the visitor
 * typed (`.claude/rules/ai.md`): without a digit or one of these in the query, the model made them up — dropped.
 */
const AMOUNT_WORDS =
  /(?<!\p{L})(mil+i[oó]n\p{L}*|mio|mill|miljo[eo]n\p{L}*|milion\p{L}*|mil|thousand|tausend|mille|duizend|tusen|tuhat|medio|half|halbe?)(?!\p{L})/u;

/** Whether the query states amounts (a digit, or an amount word). */
export const statesAmounts = (query: string): boolean => /\p{Nd}/u.test(query) || AMOUNT_WORDS.test(query);

/**
 * The answer with everything outside the vocabulary and bounds dropped, and amounts the query does not state (what
 * the eval compares, what is cached).
 */
export function cleanAnswer(raw: SearchAiAnswer, query: string): SearchAiAnswer {
  const amounts = statesAmounts(query.toLowerCase());
  const vocab = <T extends string>(list: readonly string[], allowed: Record<T, unknown>): T[] => {
    const out: T[] = [];
    for (const item of list) {
      const k = item.trim().toLowerCase();
      if (Object.hasOwn(allowed, k) && !out.includes(k as T)) out.push(k as T);
      if (out.length >= MAX_TERMS) break;
    }
    return out;
  };
  const places: string[] = [];
  for (const p of raw.places) {
    const name = p.trim().replace(/\s+/g, ' ');
    // A place name is letters, blanks and - ' . (S12-08 review): anything else is not a name (and never free text).
    if (name === '' || name.length > PLACE_MAX_CHARS || !PLACE_RE.test(name)) continue;
    if (!places.some((x) => x.toLowerCase() === name.toLowerCase())) places.push(name);
    if (places.length >= MAX_PLACES) break;
  }
  let priceMin = (amounts && euros(raw.priceMin)) || null;
  let priceMax = (amounts && euros(raw.priceMax)) || null;
  if (priceMin !== null && priceMax !== null && priceMin > priceMax) [priceMin, priceMax] = [priceMax, priceMin];
  let areaMin = (amounts && area(raw.areaMin)) || null;
  let areaMax = (amounts && area(raw.areaMax)) || null;
  if (areaMin !== null && areaMax !== null && areaMin > areaMax) [areaMin, areaMax] = [areaMax, areaMin];
  const reference = raw.reference?.trim() ?? '';
  return {
    transaction: raw.transaction,
    newBuild: raw.newBuild === true ? true : null,
    types: vocab<TypeConcept>(raw.types, TYPE_CONCEPTS),
    features: vocab<FeatureConcept>(raw.features, FEATURE_CONCEPTS),
    places,
    bedsMin: count(raw.bedsMin) ?? null,
    bathsMin: count(raw.bathsMin) ?? null,
    priceMin,
    priceMax,
    areaMin,
    areaMax,
    reference: REFERENCE_RE.test(reference) ? reference.toUpperCase() : null,
    sort: raw.sort,
  };
}

/** What the visitor's words were understood as (`/v2/listings` filters) and what found no match. */
export interface ResolvedFilters {
  query: Omit<WebsiteListingsQuery, 'sort' | 'limit' | 'cursor' | '_k' | 'lang'> & {
    sort?: WebsiteListingsQuery['sort'];
  };
  /** Places, types or features of the answer the taxonomy does not know (shown back; places become free text). */
  unmatched: string[];
  /** Nothing usable came out of the answer: search the words instead. */
  empty: boolean;
}

const first = <T extends string>(terms: readonly string[], find: (t: string) => readonly T[]): readonly T[] => {
  for (const t of terms) {
    const hit = find(t);
    if (hit.length > 0) return hit;
  }
  return [];
};

const CURRENCY_CENTS = 100;
const MAX_TEXT = 100;

/**
 * Maps a clean answer to listing filters through the taxonomy (in memory). A feature is one id (features are ANDed:
 * "pool" must not require both a private and a communal one); a type may be several (types are ORed). Unknown places
 * search as free text, so "Benahavís" still finds listings whose text names it.
 */
export function toFilters(answer: SearchAiAnswer, vocabulary: SearchVocabulary): ResolvedFilters {
  const unmatched: string[] = [];
  const types = new Set<string>();
  for (const c of answer.types) {
    const ids = first(TYPE_CONCEPTS[c as TypeConcept] ?? [], vocabulary.types);
    if (ids.length === 0) unmatched.push(c);
    for (const id of ids) types.add(id);
  }
  const features = new Set<string>();
  for (const c of answer.features) {
    const ids = first(FEATURE_CONCEPTS[c as FeatureConcept] ?? [], vocabulary.features);
    if (ids[0] === undefined) unmatched.push(c);
    else features.add(ids[0]);
  }
  const locations = new Set<string>();
  const text: string[] = [];
  for (const p of answer.places) {
    const ids = vocabulary.locations(p);
    if (ids.length === 0) {
      unmatched.push(p);
      text.push(p);
    }
    for (const id of ids) locations.add(id);
  }
  const query: ResolvedFilters['query'] = {};
  if (answer.reference !== null) query.q = answer.reference;
  else if (text.length > 0) query.q = text.join(' ').slice(0, MAX_TEXT);
  if (answer.transaction !== null) query.transaction = answer.transaction;
  // New builds are development units (PLAN §3: developments carry the new-build inventory).
  if (answer.newBuild === true) query.kind = 'UNIT';
  if (types.size > 0) query.types = [...types].slice(0, 50);
  if (locations.size > 0) query.locations = [...locations].slice(0, 50);
  if (features.size > 0) query.features = [...features].slice(0, 20);
  if (answer.priceMin !== null) query.priceMin = answer.priceMin * CURRENCY_CENTS;
  if (answer.priceMax !== null) query.priceMax = answer.priceMax * CURRENCY_CENTS;
  if (answer.bedsMin !== null) query.bedsMin = answer.bedsMin;
  if (answer.bathsMin !== null) query.bathsMin = answer.bathsMin;
  if (answer.areaMin !== null) query.areaMin = answer.areaMin;
  if (answer.areaMax !== null) query.areaMax = answer.areaMax;
  if (answer.sort !== null) query.sort = answer.sort;
  const { sort: _sort, ...filters } = query;
  return { query, unmatched, empty: Object.keys(filters).length === 0 };
}
