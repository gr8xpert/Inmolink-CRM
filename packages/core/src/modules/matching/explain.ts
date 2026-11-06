import { DEFAULT_UI_LOCALE, isUiLocale } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';

/**
 * The match engine's scoring and explanation (R2-02b, PLAN §7 M9), pure: for each hard criterion of a client profile,
 * whether a listing satisfies it, from structured data only — the explanation's words come from i18n keys
 * (`contacts.matchExplanation.*`, EN + ES), never from a model.
 *
 * Hard filters allow two near misses, so an explanation can show what is not met ("6% over budget", "4/5 must-haves"):
 * - price up to `PRICE_TOLERANCE` (10%) over the profile's maximum (the minimum is strict);
 * - up to a quarter of the must-have features missing, rounded down (`allowedMissing`: 4/5 passes, 2/3 does not).
 * Everything else (transaction, property type, place, bedrooms, bathrooms, built area) is strict. The SQL candidate
 * queries (`repo.ts`) apply the same rule; `passesHardFilters` re-checks it here.
 */

/** Price may be this much over the profile's maximum (a fraction; `withinTolerance` is its exact test). */
export const PRICE_TOLERANCE = 0.1;
/** The neutral semantic score: either vector is missing (embeddings off, not embedded yet). */
export const NEUTRAL_SEMANTIC = 0.5;
/** Weights of the total score (the learned boost of R2-02c is added on top). */
export const HARD_WEIGHT = 0.7;
export const SEMANTIC_WEIGHT = 0.3;
/** A match is recorded only at or above this total. */
export const MATCH_MIN_TOTAL = 0.6;

/** Price within the tolerance over `max`, in exact integer arithmetic (the SQL's `price * 10 <= max * 11`). */
export const withinTolerance = (priceCents: number, maxCents: number): boolean => priceCents * 10 <= maxCents * 11;

/** Must-haves that may be missing: a quarter of them, rounded down. */
export const allowedMissing = (total: number): number => Math.floor(total / 4);

export interface MatchProfileCriteria {
  transactionType: string | null;
  propertyTypeIds: readonly string[];
  locationIds: readonly string[];
  featureIds: readonly string[];
  priceMinCents: number | null;
  priceMaxCents: number | null;
  bedsMin: number | null;
  bathsMin: number | null;
  areaMinM2: number | null;
  areaMaxM2: number | null;
}

export interface MatchListingFacts {
  transactionType: string;
  propertyTypeId: string;
  /** Country, region, city and area ids. */
  locationIds: readonly string[];
  featureIds: readonly string[];
  /** Null: price on request. */
  priceCents: number | null;
  beds: number | null;
  baths: number | null;
  areaM2: number | null;
}

export type CriterionKey =
  | 'transaction'
  | 'propertyType'
  | 'location'
  | 'price'
  | 'bedrooms'
  | 'bathrooms'
  | 'area'
  | 'mustHaves';

export interface CriterionResult {
  key: CriterionKey;
  ok: boolean;
  /** 0–1: 1 when met; partial for a near miss (price over budget within tolerance, some must-haves). */
  score: number;
}

/** Stored as `client_profile_matches.explanation` (version 1). */
export interface MatchExplanation {
  v: 1;
  /** The profile's criteria in a fixed order, each satisfied or not. */
  criteria: CriterionResult[];
  satisfied: CriterionKey[];
  unsatisfied: CriterionKey[];
  /** Whole percent over (> 0) or under (< 0) the profile's maximum price; null: no maximum or price on request. */
  priceDeltaPct: number | null;
  /** Price on request while the profile has a price range. */
  priceOnRequest: boolean;
  /** Must-haves the listing has, of the profile's; null: the profile names none. */
  mustHaves: { met: number; total: number } | null;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Each of the profile's hard criteria against the listing (only those the profile sets). */
export function explainMatch(p: MatchProfileCriteria, l: MatchListingFacts): MatchExplanation {
  const criteria: CriterionResult[] = [];
  const add = (key: CriterionKey, ok: boolean, score = ok ? 1 : 0) => criteria.push({ key, ok, score });

  if (p.transactionType !== null) add('transaction', p.transactionType === l.transactionType);
  if (p.propertyTypeIds.length > 0) add('propertyType', p.propertyTypeIds.includes(l.propertyTypeId));
  if (p.locationIds.length > 0)
    add(
      'location',
      p.locationIds.some((id) => l.locationIds.includes(id)),
    );

  let priceDeltaPct: number | null = null;
  let priceOnRequest = false;
  if (p.priceMinCents !== null || p.priceMaxCents !== null) {
    if (l.priceCents === null) {
      priceOnRequest = true;
      add('price', false);
    } else {
      const overMin = p.priceMinCents === null || l.priceCents >= p.priceMinCents;
      let score = overMin ? 1 : 0;
      let ok = overMin;
      if (p.priceMaxCents !== null && l.priceCents > p.priceMaxCents) {
        ok = false;
        if (p.priceMaxCents > 0) {
          const over = (l.priceCents - p.priceMaxCents) / p.priceMaxCents;
          priceDeltaPct = Math.round(over * 100);
          // a near miss scores 1 → 0.5 across the tolerance; beyond it, 0 (refused)
          score =
            overMin && withinTolerance(l.priceCents, p.priceMaxCents) ? clamp01(1 - over / (2 * PRICE_TOLERANCE)) : 0;
        } else {
          score = 0;
        }
      } else if (p.priceMaxCents !== null && p.priceMaxCents > 0) {
        priceDeltaPct = Math.round(((l.priceCents - p.priceMaxCents) / p.priceMaxCents) * 100);
      }
      add('price', ok, score);
    }
  }

  const atLeast = (key: CriterionKey, min: number | null, value: number | null) => {
    if (min !== null) add(key, value !== null && value >= min);
  };
  atLeast('bedrooms', p.bedsMin, l.beds);
  atLeast('bathrooms', p.bathsMin, l.baths);
  if (p.areaMinM2 !== null || p.areaMaxM2 !== null) {
    const a = l.areaM2;
    add('area', a !== null && (p.areaMinM2 === null || a >= p.areaMinM2) && (p.areaMaxM2 === null || a <= p.areaMaxM2));
  }

  let mustHaves: MatchExplanation['mustHaves'] = null;
  const wanted = [...new Set(p.featureIds)];
  if (wanted.length > 0) {
    const has = new Set(l.featureIds);
    const met = wanted.filter((f) => has.has(f)).length;
    mustHaves = { met, total: wanted.length };
    add('mustHaves', met === wanted.length, met / wanted.length);
  }

  return {
    v: 1,
    criteria,
    satisfied: criteria.filter((c) => c.ok).map((c) => c.key),
    unsatisfied: criteria.filter((c) => !c.ok).map((c) => c.key),
    priceDeltaPct,
    priceOnRequest,
    mustHaves,
  };
}

/** The hard filters with their two tolerances (the SQL candidate queries' rule, re-checked). */
export function passesHardFilters(e: MatchExplanation): boolean {
  return e.criteria.every((c) => {
    if (c.ok) return true;
    // over the maximum within the tolerance (the minimum met): a near miss, not a refusal
    if (c.key === 'price') return c.score > 0;
    if (c.key === 'mustHaves' && e.mustHaves)
      return e.mustHaves.total - e.mustHaves.met <= allowedMissing(e.mustHaves.total);
    return false;
  });
}

/** The hard fit: the mean of the criteria's scores (1 when the profile sets none). */
export function hardScore(e: MatchExplanation): number {
  if (e.criteria.length === 0) return 1;
  return clamp01(e.criteria.reduce((s, c) => s + c.score, 0) / e.criteria.length);
}

export interface MatchScore {
  hard: number;
  /** Null: no vector on one side (the total used `NEUTRAL_SEMANTIC`). */
  semantic: number | null;
  boost: number;
  total: number;
}

/** Hard fit and semantic similarity (cosine, clamped to 0–1; null → neutral) into the total; boost 0 until R2-02c. */
export function scoreMatch(e: MatchExplanation, similarity: number | null, boost = 0): MatchScore {
  const hard = hardScore(e);
  const semantic = similarity === null || !Number.isFinite(similarity) ? null : clamp01(similarity);
  const total = HARD_WEIGHT * hard + SEMANTIC_WEIGHT * (semantic ?? NEUTRAL_SEMANTIC) + boost;
  return { hard, semantic, boost, total };
}

/**
 * The explanation in words, one line per criterion in the profile's order, then a summary — from i18n keys only
 * (`contacts.matchExplanation`), in the member's UI locale (EN fallback).
 */
export function explanationText(e: MatchExplanation, locale: string): { summary: string; lines: string[] } {
  const t = translator(isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE, 'contacts');
  const lines = e.criteria.map((c) => {
    if (c.key === 'price') {
      if (e.priceOnRequest) return t('matchExplanation.price.onRequest');
      if (c.ok) return t('matchExplanation.price.ok');
      if (e.priceDeltaPct !== null && e.priceDeltaPct > 0) {
        return t('matchExplanation.price.over', { pct: e.priceDeltaPct });
      }
      return t('matchExplanation.price.under');
    }
    if (c.key === 'mustHaves' && e.mustHaves) {
      return t('matchExplanation.mustHaves', { met: e.mustHaves.met, total: e.mustHaves.total });
    }
    return t(`matchExplanation.${c.key}.${c.ok ? 'ok' : 'no'}`);
  });
  return {
    summary: t('matchExplanation.summary', { met: e.satisfied.length, total: e.criteria.length }),
    lines,
  };
}
