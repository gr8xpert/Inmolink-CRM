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
const NUMBER_RE = /\d+(?:[.,   ]\d+)*/gu;
/** "m2" is a unit, not the figure 2. */
const UNIT_RE = /(\d\s?|\s|^)m2(?![0-9])/gi;
/** Prices, commission and currencies never belong in the copy (CLAUDE.md "Never"). */
const BANNED_MARKS: readonly { re: RegExp; label: string }[] = [
  { re: /[€$£¥]/u, label: 'currency' },
  { re: /\b(?:eur|euros?|usd|gbp)\b/iu, label: 'currency' },
  { re: /%|\bpercent\b|\bpor ciento\b/iu, label: 'percentage' },
];

function figuresIn(text: string): string[] {
  return text.replace(UNIT_RE, '$1m²').match(NUMBER_RE) ?? [];
}

/**
 * The readings of a written figure, each a list of numbers that must all be allowed: `1.200` / `1,200` / `1 200`
 * read 1200, `120,5` and `1.5` read as decimals, and figures side by side (`3 2`) read as each one.
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

/** Every number the copy may contain. */
export function allowedFigures(facts: StudioFacts, source?: StudioSource): Set<number> {
  const out = new Set<number>();
  const add = (v: number | null) => {
    if (v === null || !Number.isFinite(v)) return;
    out.add(v);
    out.add(Math.round(v));
  };
  for (const v of [facts.bedrooms, facts.bathrooms, facts.builtM2, facts.plotM2, facts.terraceM2, facts.yearBuilt]) {
    add(v);
  }
  const named = [facts.propertyType ?? '', ...facts.location, ...facts.features];
  // the source arrives wrapped in untrusted blocks (`untrustedBlock`): the tags' nonces are hex, not facts
  if (source) named.push(withoutTags(source.title), withoutTags(source.description ?? ''));
  for (const text of named)
    for (const t of figuresIn(text)) for (const reading of readingsOf(t)) for (const v of reading) add(v);
  return out;
}

/** What the copy must not contain: figures outside `allowed`, and price / percentage / currency marks. */
export function copyViolations(copy: ListingCopy, allowed: ReadonlySet<number>): string[] {
  const out = new Set<string>();
  for (const text of [copy.title, copy.description, copy.metaTitle, copy.metaDescription]) {
    for (const token of figuresIn(text)) {
      if (!readingsOf(token).some((reading) => reading.every((v) => allowed.has(v)))) out.add(token);
    }
    for (const { re, label } of BANNED_MARKS) if (re.test(text)) out.add(label);
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
