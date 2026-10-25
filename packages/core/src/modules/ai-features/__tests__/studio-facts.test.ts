import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EvalCase, UNTRUSTED_TEXT_RULE, untrustedBlock } from '@inmolink/platform/ai';
import { describe, expect, it } from 'vitest';
import { LISTING_STUDIO_PROMPT } from '../studio';
import {
  allowedFigures,
  copyViolations,
  ListingCopy,
  moneyFigures,
  moneyLeaks,
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
      expect(
        copyViolations(parsed.data as ListingCopy, allowedFigures(input.facts, input.source), input.locale),
        c.name,
      ).toEqual([]);
    }
  });

  it('[S12-02] numbers in generated text match listing facts: spelled-out numbers and ordinals per locale', () => {
    expect(copyViolations(copy('A villa with three bedrooms and two bathrooms.'), allowed, 'en')).toEqual([]);
    expect(copyViolations(copy('Only five minutes from the beach, twenty years young.'), allowed, 'en')).toEqual([
      'five',
      'twenty',
    ]);
    expect(copyViolations(copy('Apartment on the fifth floor.'), allowed, 'en')).toEqual(['fifth']);
    expect(copyViolations(copy('Villa con tres dormitorios, a cinco minutos de la playa.'), allowed, 'es')).toEqual([
      'cinco',
    ]);
    expect(copyViolations(copy('Villa mit drei Schlafzimmern, seit zwanzig Jahren.'), allowed, 'de')).toEqual([
      'zwanzig',
    ]);
    expect(copyViolations(copy('Villa à dix minutes de la plage.'), allowed, 'fr')).toEqual(['dix']);
    expect(copyViolations(copy('Villa op vijf minuten van het strand.'), allowed, 'nl')).toEqual(['vijf']);
    expect(copyViolations(copy('Villa med fem sovrum.'), allowed, 'sv')).toEqual(['fem']);
    // idioms that are not figures stay allowed
    expect(
      copyViolations(copy('Una de las mejores villas en primera línea, maison neuve, one of a kind.'), allowed, 'es'),
    ).toEqual([]);
  });

  it('[S12-02] numbers in generated text match listing facts: digits of any script are figures', () => {
    expect(copyViolations(copy('Villa with ٥ bedrooms.'), allowed, 'en')).toEqual(['٥']);
    expect(copyViolations(copy('Villa with ４ bedrooms.'), allowed, 'en')).toEqual(['４']);
  });

  it('[S12-02] percent and currency words of every content locale are refused', () => {
    for (const text of ['3 Prozent', '3 pour cent', '3 procent', '3 prosent', '3 процента']) {
      expect(copyViolations(copy(text), allowed, 'en')).toContain('percentage');
    }
    for (const text of ['1200 CHF', '1200 kr', '1200 SEK', '1200 Pfund', '1200 dollars', '1200 dólares']) {
      expect(copyViolations(copy(text), allowed, 'en')).toContain('currency');
    }
  });

  it('[S12-02] the source text cannot carry the price into the copy: large source figures are not allowed', () => {
    const source = { locale: 'es', title: 'Villa', description: 'Precio 450.000. Parcela de 1.200 m², a 15 minutos.' };
    const withSource = allowedFigures(facts, source);
    expect(withSource.has(450_000)).toBe(false);
    expect(withSource.has(1_200)).toBe(true); // a fact (plot)
    expect(withSource.has(15)).toBe(true);
    expect(copyViolations(copy('Por solo 450.000, a 15 minutos.'), withSource, 'es')).toEqual(['450.000']);
    const ref = allowedFigures(facts, { locale: 'en', title: 'Villa', description: 'Ref 1234567 and 9999 more.' });
    expect(ref.has(1_234_567)).toBe(false);
    expect(ref.has(9_999)).toBe(true);
  });

  it('[S12-02] the copy is compared server-side with the price and commission; facts stay allowed', () => {
    const money = moneyFigures(
      {
        priceCents: 450_000_00,
        priceToCents: null,
        communityFeeMonthCents: 120_00,
        ibiYearCents: null,
        garbageTaxYearCents: null,
        commissionBp: 300,
        commissionFixedCents: null,
      },
      facts,
    );
    expect(money.has(450_000)).toBe(true);
    expect(money.has(450)).toBe(true); // "450k" / "450 mil"
    expect(money.has(120)).toBe(true);
    expect(money.has(3)).toBe(false); // 3 % commission, but 3 bedrooms is a fact
    expect(moneyLeaks(copy('Yours for 450.000 or 450 mil, fees 120 a month.'), money)).toEqual([
      '450.000',
      '450',
      '120',
    ]);
    expect(moneyLeaks(copy('A villa with 3 bedrooms on 1.200 m².'), money)).toEqual([]);
    // a source figure equal to the price is never allowed, even below the size limit
    const small = moneyFigures({ ...nullMoney, priceCents: 9_500_00 }, facts);
    expect(allowedFigures(facts, { locale: 'en', title: 'x', description: 'Only 9500.' }, small).has(9_500)).toBe(
      false,
    );
  });
});

const nullMoney = {
  priceCents: null,
  priceToCents: null,
  communityFeeMonthCents: null,
  ibiYearCents: null,
  garbageTaxYearCents: null,
  commissionBp: null,
  commissionFixedCents: null,
};
