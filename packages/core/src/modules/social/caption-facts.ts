import { SOCIAL_LIMITS } from '@inmolink/contracts';
import { z } from 'zod';

/**
 * The captions' answer schema and fact check (S12-07), pure: every number in a caption must be one of the listing's
 * facts (or a shorthand of its price) — an invented figure drops the caption.
 */

export const CaptionsAnswer = z.object({
  captions: z
    .array(z.object({ locale: z.string().max(10), text: z.string().min(1).max(SOCIAL_LIMITS.captionChars) }))
    .max(SOCIAL_LIMITS.captionLocales),
});

/** The prompt file (`packages/core/prompts/social-captions/v1.md`). */
export const CAPTIONS_PROMPT = { id: 'social-captions', version: 1 } as const;

/** Digits in a text as plain numbers (`1.250.000`, `1,250,000` and `1250000` alike; `320 m²` → 320). */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d[\d.,\s]*\d|\d/g)) {
    const digits = m[0].replace(/[\s.,]/g, '');
    const n = Number(digits);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Whether every number of `text` is one the facts allow (`allowedNumbers`). */
export function numbersMatchFacts(text: string, allowed: ReadonlySet<number>): boolean {
  return numbersIn(text).every((n) => allowed.has(n));
}

export interface Facts {
  transaction: string;
  propertyType: string | null;
  place: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  builtM2: number | null;
  plotM2: number | null;
  terraceM2: number | null;
  price: { amount: number; currency: string; period: string | null } | null;
  energyRating: string | null;
}

export function allowedNumbers(f: Facts): Set<number> {
  const set = new Set<number>();
  for (const v of [f.bedrooms, f.bathrooms, f.builtM2, f.plotM2, f.terraceM2]) {
    if (v !== null) {
      set.add(v);
      set.add(Math.round(v));
    }
  }
  if (f.price) {
    const { amount } = f.price;
    set.add(amount);
    // Shorthands of the price: "450k" (thousands) and "1.25M" (millions; the digits without separators: 125).
    if (amount % 1_000 === 0) set.add(amount / 1_000);
    if (amount % 10_000 === 0) set.add(Number(String(amount / 1_000_000).replace('.', '')));
  }
  return set;
}
