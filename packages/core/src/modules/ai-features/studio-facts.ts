/**
 * Listing Studio facts and the deterministic fact check (S12-02, PLAN §8 #1, ai rules "facts are injected, never
 * generated"). Pure functions, no I/O:
 *
 * - `studioFacts`: what the model is told about a listing in one locale (names from the taxonomy in that locale).
 *   Never the price, commission, owner, address, reference or any private field.
 * - `allowedFigures`: every number the copy may contain — the numeric facts (m² also rounded), digits inside the
 *   place, type and feature names, and the figures of the agency's own source text.
 * - `copyViolations`: every figure in the copy that is not allowed, and every price / percentage / currency mark.
 *   Empty = the copy may be stored. A copy with violations is repaired once (the model is told what was rejected),
 *   then dropped.
 */

import { createHash } from 'node:crypto';
import type { ListingStudioTone } from '@inmolink/contracts';
import { z } from 'zod';

/** The model's answer for one locale (validated by the gateway; one repair retry on invalid output). */
export const ListingCopy = z
  .object({
    title: z.string().trim().min(10).max(120),
    description: z.string().trim().min(150).max(5_000),
    metaTitle: z.string().trim().min(10).max(70),
    metaDescription: z.string().trim().min(50).max(160),
  })
  .strict();
export type ListingCopy = z.infer<typeof ListingCopy>;

export interface StudioFacts {
  transaction: 'SALE' | 'RENT_LONG_TERM' | 'RENT_SHORT_TERM';
  propertyType: string | null;
  /** Most specific place first (area, city, province…). */
  location: string[];
  bedrooms: number | null;
  bathrooms: number | null;
  builtM2: number | null;
  plotM2: number | null;
  terraceM2: number | null;
  yearBuilt: number | null;
  energyRating: string | null;
  features: string[];
  photos: { room: string; count: number }[];
}

export interface StudioSource {
  locale: string;
  title: string;
  description: string | null;
}

/** The whole user message of one call (`prompts/listing-studio/v1.md`). */
export interface StudioInput {
  locale: string;
  tone: ListingStudioTone;
  facts: StudioFacts;
  source?: StudioSource;
  rejected?: string[];
}

export interface StudioFactsListing {
  transactionType: StudioFacts['transaction'];
  bedrooms: number | null;
  bathrooms: number | null;
  builtM2: number | null;
  plotM2: number | null;
  terraceM2: number | null;
  yearBuilt: number | null;
  energyRating: string | null;
}

/** Builds the facts from the listing and its names in the target locale (`null` facts are omitted by the prompt). */
export function studioFacts(
  listing: StudioFactsListing,
  names: { propertyType: string | null; location: string[]; features: string[] },
  rooms: readonly (string | null)[],
): StudioFacts {
  const counts = new Map<string, number>();
  for (const r of rooms) if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
  return {
    transaction: listing.transactionType,
    propertyType: names.propertyType,
    location: names.location,
    bedrooms: listing.bedrooms,
    bathrooms: listing.bathrooms,
    builtM2: listing.builtM2,
    plotM2: listing.plotM2,
    terraceM2: listing.terraceM2,
    yearBuilt: listing.yearBuilt,
    // EXEMPT / PENDING are not a rating to advertise
    energyRating: listing.energyRating && /^[A-G]$/.test(listing.energyRating) ? listing.energyRating : null,
    features: [...names.features].sort(),
    photos: [...counts.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([room, count]) => ({ room, count })),
  };
}

/** Thousands separators and decimal marks a figure may contain (incl. no-break spaces). */
const SEPARATOR_RE = /[.,   ]/u;
/** Any decimal digit, not only ASCII (`\p{Nd}`): a figure in another script is still a figure. */
const NUMBER_RE = /\p{Nd}+(?:[.,   ]\p{Nd}+)*/gu;
/** "m2" is a unit, not the figure 2. */
const UNIT_RE = /(\d\s?|\s|^)m2(?![0-9])/gi;

/** A word or phrase on its own (letters around it end the match; `\b` is ASCII-only). */
const word = (w: string) => new RegExp(`(?<![\\p{L}\\p{N}])${w}(?![\\p{L}\\p{N}])`, 'iu');
/**
 * Prices, commission and currencies never belong in the copy (CLAUDE.md "Never"): symbols, ISO codes and the words
 * for "percent" / currencies in the content locales.
 */
const BANNED_MARKS: readonly { re: RegExp; label: string }[] = [
  { re: /[€$£¥₽₣₤]/u, label: 'currency' },
  ...['eur', 'euros?', 'usd', 'gbp', 'chf', 'sek', 'nok', 'dkk', 'kr', 'dollars?', 'dólares?', 'pfund', 'libras?'].map(
    (w) => ({ re: word(w), label: 'currency' }),
  ),
  { re: /%/u, label: 'percentage' },
  ...[
    'percent',
    'per cent',
    'por ciento',
    'porcentaje',
    'prozent',
    'pour cent',
    'pourcentage',
    'procent',
    'prosent',
    'процент\\p{L}*',
  ].map((w) => ({ re: word(w), label: 'percentage' })),
];

/**
 * Spelled-out numbers and ordinals per content locale (lowercase). Left out on purpose: words for one and "first" /
 * "second" (articles and idioms: "one of", "un", "ein", "primera línea", "second home", "segunda vivienda"), and words
 * that mostly mean something else in listings (fr "neuf" = new, es "cuarto" = room, "quinta" = country estate).
 */
// biome-ignore format: a compact word table reads better than one entry per line
const NUMBER_WORDS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  en: {
    two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
    thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
    dozen: 12, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  },
  es: {
    dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
    trece: 13, catorce: 14, quince: 15, dieciséis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20,
    veintiuno: 21, veintidós: 22, veintitrés: 23, veinticuatro: 24, veinticinco: 25, treinta: 30, cuarenta: 40,
    cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100, mil: 1000, docena: 12,
    tercer: 3, tercero: 3, tercera: 3, sexto: 6, sexta: 6, séptimo: 7, séptima: 7, octavo: 8, octava: 8, noveno: 9,
    novena: 9, décimo: 10, décima: 10,
  },
  de: {
    zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12,
    zwanzig: 20, dreißig: 30, vierzig: 40, fünfzig: 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90,
    hundert: 100, tausend: 1000, dritte: 3, dritten: 3, dritter: 3, vierte: 4, vierten: 4, fünfte: 5, fünften: 5,
    sechste: 6, siebte: 7, achte: 8, neunte: 9, zehnte: 10,
  },
  fr: {
    deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, dix: 10, onze: 11, douze: 12, treize: 13,
    quatorze: 14, quinze: 15, seize: 16, vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60, cent: 100,
    mille: 1000, troisième: 3, quatrième: 4, cinquième: 5, sixième: 6, septième: 7, huitième: 8, neuvième: 9,
    dixième: 10,
  },
  nl: {
    twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9, tien: 10, elf: 11, twaalf: 12,
    twintig: 20, dertig: 30, veertig: 40, vijftig: 50, honderd: 100, duizend: 1000, derde: 3, vierde: 4, vijfde: 5,
    zesde: 6, zevende: 7, achtste: 8, negende: 9, tiende: 10,
  },
  sv: {
    två: 2, tre: 3, fyra: 4, fem: 5, sex: 6, sju: 7, åtta: 8, nio: 9, tio: 10, elva: 11, tolv: 12, tjugo: 20,
    trettio: 30, fyrtio: 40, femtio: 50, hundra: 100, tusen: 1000, tredje: 3, fjärde: 4, femte: 5, sjätte: 6,
    sjunde: 7, åttonde: 8, nionde: 9, tionde: 10,
  },
};

function figuresIn(text: string): string[] {
  return text.replace(UNIT_RE, '$1m²').match(NUMBER_RE) ?? [];
}

/**
 * Spelled-out numbers in `text` in the copy's locale, with their values. Only that locale's words: another language's
 * number word is often an ordinary word here (nl "ten" = at, de "die").
 */
export function numberWordsIn(text: string, locale: string): { word: string; value: number }[] {
  const list = NUMBER_WORDS[locale.slice(0, 2)];
  if (!list) return [];
  const out: { word: string; value: number }[] = [];
  for (const w of text.toLowerCase().split(/[^\p{L}]+/u)) {
    const value = Object.hasOwn(list, w) ? list[w] : undefined;
    if (value !== undefined) out.push({ word: w, value });
  }
  return out;
}

/**
 * The readings of a written figure, each a list of numbers that must all be allowed: `1.200` / `1,200` / `1 200`
 * read 1200, `120,5` and `1.5` read as decimals, and figures side by side (`3 2`) read as each one. Digits of other
 * scripts read as NaN: never allowed.
 */
export function readingsOf(token: string): number[][] {
  const parts = token.split(SEPARATOR_RE);
  if (parts.length === 1) return [[Number(token)]];
  const out: number[][] = [];
  if (parts.slice(1).every((p) => p.length === 3) && (parts[0]?.length ?? 0) <= 3) out.push([Number(parts.join(''))]);
  const sep = token.charAt(parts[0]?.length ?? 0);
  if (parts.length === 2 && (sep === '.' || sep === ',')) out.push([Number(`${parts[0]}.${parts[1]}`)]);
  if (/[^.,0-9]/u.test(token)) out.push(parts.map(Number));
  return out;
}

const UNTRUSTED_TAG_RE = /<\/?untrusted_[a-z0-9_]+>/g;
const withoutTags = (text: string) => text.replace(UNTRUSTED_TAG_RE, ' ');

/** A figure of the source this large is a price or a reference, not a description fact (unless it is a fact). */
const SOURCE_FIGURE_MAX = 10_000;
const SOURCE_DIGITS_MAX = 6;

/**
 * Every number the copy may contain: the numeric facts (m² also rounded), digits in the place, type and feature
 * names, and the figures of the agency's own source text — except, there, figures ≥ 10,000 or of more than 6 digits
 * and any of `forbidden` (the listing's price and commission), unless they equal a fact.
 */
export function allowedFigures(
  facts: StudioFacts,
  source?: StudioSource,
  forbidden: Iterable<number> = [],
): Set<number> {
  const out = new Set<number>();
  const add = (v: number | null) => {
    if (v === null || !Number.isFinite(v)) return;
    out.add(v);
    out.add(Math.round(v));
  };
  for (const v of [facts.bedrooms, facts.bathrooms, facts.builtM2, facts.plotM2, facts.terraceM2, facts.yearBuilt]) {
    add(v);
  }
  for (const text of [facts.propertyType ?? '', ...facts.location, ...facts.features]) {
    for (const t of figuresIn(text)) for (const reading of readingsOf(t)) for (const v of reading) add(v);
  }
  const facty = new Set(out);
  const banned = new Set(forbidden);
  // the source arrives wrapped in untrusted blocks (`untrustedBlock`): the tags' nonces are hex, not facts
  for (const text of source ? [withoutTags(source.title), withoutTags(source.description ?? '')] : []) {
    for (const t of figuresIn(text)) {
      const digits = t.replace(/\D/gu, '').length;
      const readings = readingsOf(t);
      // one large reading condemns the token: "450.000" must not get in as 450 either
      const large = readings.some((r) => r.some((v) => !facty.has(v) && (v >= SOURCE_FIGURE_MAX || banned.has(v))));
      if (digits > SOURCE_DIGITS_MAX || large) continue;
      for (const reading of readings) for (const v of reading) add(v);
    }
  }
  return out;
}

/**
 * What the copy must not contain: figures (digits, or spelled out in `locale`) outside `allowed`, and price,
 * percentage and currency marks.
 */
export function copyViolations(copy: ListingCopy, allowed: ReadonlySet<number>, locale = 'en'): string[] {
  const out = new Set<string>();
  for (const text of [copy.title, copy.description, copy.metaTitle, copy.metaDescription]) {
    for (const token of figuresIn(text)) {
      if (!readingsOf(token).some((reading) => reading.every((v) => allowed.has(v)))) out.add(token);
    }
    for (const { word: w, value } of numberWordsIn(text, locale)) if (!allowed.has(value)) out.add(w);
    for (const { re, label } of BANNED_MARKS) if (re.test(text)) out.add(label);
  }
  return [...out];
}

/**
 * The listing's money figures, compared server-side (never sent to the provider): price (also in thousands and
 * millions), price-range end, fees and taxes, fixed commission and the commission percentage — minus the facts, which
 * the copy may state. Null and zero amounts are skipped.
 */
export function moneyFigures(
  money: {
    priceCents: number | null;
    priceToCents: number | null;
    communityFeeMonthCents: number | null;
    ibiYearCents: number | null;
    garbageTaxYearCents: number | null;
    commissionBp: number | null;
    commissionFixedCents: number | null;
  },
  facts: StudioFacts,
): Set<number> {
  const out = new Set<number>();
  const add = (v: number) => {
    if (!Number.isFinite(v) || v <= 0) return;
    out.add(v);
    out.add(Math.round(v));
    out.add(Math.round(v * 10) / 10);
  };
  for (const cents of [money.priceCents, money.priceToCents]) {
    if (!cents) continue;
    add(cents / 100);
    if (cents >= 100_000_00) add(cents / 100 / 1_000);
    if (cents >= 1_000_000_00) add(cents / 100 / 1_000_000);
  }
  for (const cents of [
    money.communityFeeMonthCents,
    money.ibiYearCents,
    money.garbageTaxYearCents,
    money.commissionFixedCents,
  ]) {
    if (cents) add(cents / 100);
  }
  if (money.commissionBp) add(money.commissionBp / 100);
  for (const v of allowedFigures(facts)) out.delete(v);
  return out;
}

/** Figures of the copy that are one of the listing's money figures (`moneyFigures`). */
export function moneyLeaks(copy: ListingCopy, money: ReadonlySet<number>): string[] {
  const out = new Set<string>();
  for (const text of [copy.title, copy.description, copy.metaTitle, copy.metaDescription]) {
    for (const token of figuresIn(text)) {
      if (readingsOf(token).some((reading) => reading.some((v) => money.has(v)))) out.add(token);
    }
  }
  return [...out];
}

/** The listing's own source text: a locked text first, then a reviewed one, then any a person wrote. */
export function pickSource(
  translations: readonly {
    locale: string;
    title: string;
    description: string | null;
    origin: string;
    locked: boolean;
  }[],
  localeOrder: readonly string[],
): StudioSource | undefined {
  const rank = (t: (typeof translations)[number]) =>
    t.origin === 'AI_DRAFT' ? -1 : t.locked ? 3 : t.origin === 'REVIEWED' ? 2 : 1;
  const order = (l: string) => {
    const i = localeOrder.indexOf(l);
    return i === -1 ? localeOrder.length : i;
  };
  const best = [...translations]
    .filter((t) => rank(t) > 0 && (t.description ?? '').trim() !== '')
    .sort((a, b) => rank(b) - rank(a) || order(a.locale) - order(b.locale) || (a.locale < b.locale ? -1 : 1))[0];
  return best ? { locale: best.locale, title: best.title, description: best.description } : undefined;
}

/**
 * 16 hex characters of SHA-256 over what a draft is written from: the facts (ids, so a rename of a place does not
 * count) and the source text. A draft generated from other facts than the listing's current ones is not stored.
 */
export function factsHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}
