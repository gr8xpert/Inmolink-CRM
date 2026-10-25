import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EvalCase, UNTRUSTED_TEXT_RULE, untrustedBlock } from '@inmolink/platform/ai';
import { describe, expect, it } from 'vitest';
import { LISTING_STUDIO_PROMPT } from '../studio';
import {
  allowedFigures,
  copyViolations,
  ListingCopy,
  pickSource,
  readingsOf,
  type StudioFacts,
  type StudioInput,
  studioFacts,
} from '../studio-facts';

/** The Listing Studio's deterministic fact check (S12-02): numbers in generated text must match the listing facts. */

const PROMPT_FILE = fileURLToPath(new URL('../../../../prompts/listing-studio/v1.md', import.meta.url));
const EVALS_FILE = fileURLToPath(new URL('../../../../evals/listing-studio/cases.jsonl', import.meta.url));

const facts: StudioFacts = studioFacts(
  {
    transactionType: 'SALE',
    bedrooms: 3,
    bathrooms: 2,
    builtM2: 145.5,
    plotM2: 1200,
    terraceM2: null,
    yearBuilt: 2005,
    energyRating: 'EXEMPT',
  },
  { propertyType: 'Villa', location: ['Calpe', 'Alicante'], features: ['Sea views', 'Private pool'] },
  ['kitchen', 'bedroom', 'bedroom', null],
);
const allowed = allowedFigures(facts);

const copy = (description: string, extra: Partial<ListingCopy> = {}): ListingCopy => ({
  title: 'Villa with sea views in Calpe',
  description,
  metaTitle: 'Villa in Calpe',
  metaDescription: 'A bright villa with a private pool and sea views in Calpe, Alicante. Ask for a viewing today.',
  ...extra,
});

describe('Listing Studio facts and fact check (S12-02)', () => {
  it('[S12-02] facts carry no price, commission or rating that is not a CEE letter; photos are counted by room', () => {
    expect(facts).toEqual({
      transaction: 'SALE',
      propertyType: 'Villa',
      location: ['Calpe', 'Alicante'],
      bedrooms: 3,
      bathrooms: 2,
      builtM2: 145.5,
      plotM2: 1200,
      terraceM2: null,
      yearBuilt: 2005,
      energyRating: null,
      features: ['Private pool', 'Sea views'],
      photos: [
        { room: 'bedroom', count: 2 },
        { room: 'kitchen', count: 1 },
      ],
    });
    expect(JSON.stringify(facts)).not.toMatch(/price|commission|owner|address|ref/i);
  });

  it('[S12-02] numbers in generated text match listing facts: every fact may be written, in any locale format', () => {
    const ok = copy(
      'Built in 2005, this villa has 3 bedrooms and 2 bathrooms, 145,5 m² built (146 m2) on a plot of 1.200 m² — ' +
        'or 1,200 m², or 1 200 m². Sea views from every room.',
    );
    expect(copyViolations(ok, allowed)).toEqual([]);
  });

  it('[S12-02] numbers in generated text match listing facts: an invented figure is a violation', () => {
    expect(copyViolations(copy('A villa with 4 bedrooms, 10 minutes from the beach.'), allowed)).toEqual(['4', '10']);
    expect(copyViolations(copy('Fully renovated in 2019.'), allowed)).toEqual(['2019']);
    expect(copyViolations(copy('Lovely villa.', { title: 'Villa of 300 m² in Calpe' }), allowed)).toEqual(['300']);
  });

  it('[S12-02] prices, commission and currencies are never allowed, even when the figure is a fact', () => {
    expect(copyViolations(copy('Yours for €450,000.'), allowed)).toEqual(['450,000', 'currency']);
    expect(copyViolations(copy('Offered at 1200 euros a month.'), allowed)).toEqual(['currency']);
    expect(copyViolations(copy('Only 3% commission.'), allowed)).toEqual(['percentage']);
  });

  it('[S12-02] the source arrives as an untrusted block: its tag nonce is not a fact; the prompt says what it is', () => {
    const description = untrustedBlock('source_text', 'A villa 15 minutes from the coast.');
    const wrapped = allowedFigures(facts, {
      locale: 'en',
      title: untrustedBlock('source_title', 'Villa'),
      description,
    });
    const nonceDigits = [...(description.match(/untrusted_source_text_([0-9a-f]{16})/)?.[1] ?? '').matchAll(/\d+/g)];
    expect(nonceDigits.length).toBeGreaterThan(0);
    for (const [d] of nonceDigits) if (!allowed.has(Number(d))) expect(wrapped.has(Number(d)), d).toBe(false);
    expect(wrapped.has(15)).toBe(true);
    expect(readFileSync(PROMPT_FILE, 'utf8')).toContain(UNTRUSTED_TEXT_RULE);
  });

  it('[S12-02] figures of the agency own text and of place names may be repeated', () => {
    const withSource = allowedFigures(facts, {
      locale: 'en',
      title: 'Villa',
      description: 'A villa 15 minutes from the coast.',
    });
    expect(copyViolations(copy('Just 15 minutes from the coast.'), withSource)).toEqual([]);
    expect(copyViolations(copy('Just 15 minutes from the coast.'), allowed)).toEqual(['15']);
  });

  it('[S12-02] readings: thousands groups, decimal marks and figures side by side', () => {
    expect(readingsOf('1.200')).toEqual([[1200], [1.2]]);
    expect(readingsOf('120,5')).toEqual([[120.5]]);
    expect(readingsOf('3 2')).toEqual([[3, 2]]);
    expect(readingsOf('2005')).toEqual([[2005]]);
  });

  it('[S12-02] the source is a locked text first, then a reviewed one, then a human one; never an AI draft', () => {
    const t = (locale: string, origin: string, locked = false) => ({
      locale,
      title: locale,
      description: `${locale} text`,
      origin,
      locked,
    });
    expect(pickSource([t('en', 'AI_DRAFT'), t('es', 'HUMAN'), t('de', 'REVIEWED')], ['en', 'es', 'de'])?.locale).toBe(
      'de',
    );
    expect(pickSource([t('es', 'HUMAN'), t('fr', 'HUMAN', true)], ['es', 'fr'])?.locale).toBe('fr');
    expect(pickSource([t('en', 'AI_DRAFT')], ['en'])).toBeUndefined();
  });

  it('[S12-02] eval set listing-studio: every recorded answer is valid copy and passes the fact check', () => {
    const lines = readFileSync(EVALS_FILE, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const line of lines) {
      const c = EvalCase.parse(JSON.parse(line));
      const answer = c.recorded[String(LISTING_STUDIO_PROMPT.version)];
      expect(answer, `${c.name}: no recording for v${LISTING_STUDIO_PROMPT.version}`).toBeTypeOf('string');
      const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec((answer as string).trim());
      const parsed = ListingCopy.safeParse(JSON.parse(fenced?.[1] ?? (answer as string)));
      expect(parsed.success, `${c.name}: ${parsed.error?.message}`).toBe(true);
      const input = c.input as StudioInput;
      expect(copyViolations(parsed.data as ListingCopy, allowedFigures(input.facts, input.source)), c.name).toEqual([]);
    }
  });
});
