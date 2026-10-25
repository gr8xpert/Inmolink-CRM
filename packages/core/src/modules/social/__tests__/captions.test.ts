import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allowedNumbers, CaptionsAnswer, type Facts, numbersIn, numbersMatchFacts } from '../caption-facts';

const EVALS_FILE = fileURLToPath(new URL('../../../../evals/social-captions/cases.jsonl', import.meta.url));

/** The captions' fact check (S12-07): numbers in a caption must be the listing's own. */

const FACTS: Facts = {
  transaction: 'SALE',
  propertyType: 'Villa',
  place: 'Marbella',
  bedrooms: 4,
  bathrooms: 3,
  builtM2: 320,
  plotM2: 1200,
  terraceM2: null,
  price: { amount: 1_250_000, currency: 'EUR', period: null },
  energyRating: 'B',
};

describe('caption fact check (S12-07)', () => {
  it('[S12-07] numbers in any notation are read; the facts and the price shorthands pass, invented figures do not', () => {
    expect(numbersIn('4 bedrooms, 320 m², 1.250.000 € or 1,250,000 EUR')).toEqual([4, 320, 1_250_000, 1_250_000]);
    const allowed = allowedNumbers(FACTS);
    expect(numbersMatchFacts('A 4-bed villa, 3 baths, 320 m² on a 1200 m² plot: 1,250,000 EUR', allowed)).toBe(true);
    expect(numbersMatchFacts('Now only 1.25M!', allowed)).toBe(true);
    expect(numbersMatchFacts('5 bedrooms', allowed)).toBe(false);
    expect(numbersMatchFacts('Only 900,000 EUR', allowed)).toBe(false);
    expect(numbersMatchFacts('200 m from the beach', allowed)).toBe(false);
    expect(numbersMatchFacts('Sea views and a private pool ☀️', allowed)).toBe(true);
  });

  it('[S12-07] the recorded answers (evals/social-captions, an injection case too) parse and keep to the facts', () => {
    const cases = readFileSync(EVALS_FILE, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { name: string; input: { facts: Facts }; recorded: Record<string, string> });
    expect(cases.length).toBeGreaterThanOrEqual(3);
    for (const c of cases) {
      const answer = CaptionsAnswer.parse(JSON.parse(c.recorded['1'] as string));
      for (const caption of answer.captions) {
        expect(numbersMatchFacts(caption.text, allowedNumbers(c.input.facts)), `${c.name}: ${caption.locale}`).toBe(
          true,
        );
      }
    }
  });
});
