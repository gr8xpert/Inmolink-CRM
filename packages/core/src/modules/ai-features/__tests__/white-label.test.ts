import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configureAi, createAiGateway, EvalCase, filePromptSource, UNTRUSTED_TEXT_RULE } from '@inmolink/platform/ai';
import { FakeProvider, memoryAiCache, memoryAiStore } from '@inmolink/platform/ai/testing';
import { createLogger } from '@inmolink/platform/logger';
import { afterEach, describe, expect, it } from 'vitest';
import { whiteLabelLeaks } from '../../../testing/white-label';
import {
  blocksOf,
  fixtureLeaks,
  missingFacts,
  type SanitizerFixture,
  sanitizerFixture,
  sanitizerFixtures,
} from '../../../testing/white-label-fixtures';
import {
  acceptRemovals,
  applyRemovals,
  compileOwner,
  deterministicSanitizer,
  NO_OWNER,
  plainText,
  textKey,
  whiteLabelText,
} from '../../../white-label';
import {
  docTexts,
  modelInput,
  modelRemovals,
  prepareTexts,
  protectedNamesOf,
  removalsByText,
  shownOnNetwork,
  WHITE_LABEL_FEATURE,
  WHITE_LABEL_PROMPT,
} from '../white-label';

/**
 * White-label text sanitizer (S12-03): the 200-description fixture set (`testing/white-label-fixtures.ts`) through
 * the deterministic pass, then through the model pass with the gateway answering from a fake provider (unit tests
 * never call the real one) and from the live answers recorded in `evals/white-label` (`pnpm ai:eval white-label`).
 */

const PROMPTS_DIR = fileURLToPath(new URL('../../../../prompts', import.meta.url));
const EVALS_FILE = fileURLToPath(new URL('../../../../evals/white-label/cases.jsonl', import.meta.url));
const AGENCY = '01900000-0000-7000-8000-00000000c0de';
const log = createLogger({ service: 'white-label-test', level: 'silent' });

const FIXTURES = sanitizerFixtures(200);
const INDIRECT = [...new Set(FIXTURES.flatMap((f) => f.indirect.map((i) => i.sentence)))];

function gatewayWith(provider: FakeProvider, overrides: { hardMicroUsd?: number } = {}) {
  const gateway = createAiGateway({
    provider,
    models: { FAST: 'fast-model', SMART: 'smart-model' },
    pricing: { 'fast-model': { input: 1, output: 5 }, 'smart-model': { input: 5, output: 25 } },
    batchDiscountBp: 5_000,
    prompts: filePromptSource(PROMPTS_DIR),
    cache: memoryAiCache(),
    cacheTtlSeconds: 3_600,
    store: memoryAiStore(),
    budgetFor: () => ({ softMicroUsd: 1e12, hardMicroUsd: overrides.hardMicroUsd ?? 2e12 }),
    timeoutMs: 5_000,
    breaker: { failures: 1_000, openMs: 1_000 },
    logger: log,
  });
  configureAi(gateway);
  return gateway;
}

/** First names inside place names, short words of them, facts in words: parts a model must not get away with. */
const TRAPS = ['María', 'Juan', 'Mar', 'Santa', 'two bedrooms', 'dos dormitorios', 'Located in', 'Situada en'];

/**
 * A model that names every planted indirect sentence it sees (read from the untrusted blocks, escaped as the gateway
 * sends them) — plus answers a model must not get away with: a digit fact, a first name inside a place name, a fact
 * in words, a part that is not in the text (each dropped by `acceptRemovals`).
 */
function plantedModel(): FakeProvider {
  return new FakeProvider((request) => {
    const all = blocksOf(request.user).join('\n');
    const remove = INDIRECT.filter((s) => all.includes(s));
    const fact = /\d+ (?:bedrooms|dormitorios)/.exec(all)?.[0];
    if (fact) remove.push(fact);
    for (const t of TRAPS) if (all.includes(t)) remove.push(t);
    remove.push('a sentence the text does not have');
    return JSON.stringify({ remove });
  });
}

const ctx = { tenant: { agencyId: AGENCY } };

/** The served text of a fixture's description: deterministic, then the cached removals of a model run. */
async function servedWithModel(f: SanitizerFixture): Promise<string> {
  const matcher = compileOwner(f.identity);
  const texts = prepareTexts(matcher, [f.ref], [f.description]);
  const spans = await modelRemovals(ctx, texts);
  const removals = new Map(Object.entries(removalsByText(texts, spans ?? [], { protectedNames: f.places })));
  return whiteLabelText(f.description, matcher, [f.ref], removals);
}

afterEach(() => configureAi(undefined));

describe('white-label sanitizer (S12-03)', () => {
  it('[S12-03] fixture set: 200 descriptions, every one with planted contacts and facts', () => {
    expect(FIXTURES).toHaveLength(200);
    expect(FIXTURES.every((f) => f.direct.length >= 2 && f.facts.length >= 11)).toBe(true);
    // Most carry an indirect mention only the model pass finds; both languages and the tricky places are covered.
    expect(FIXTURES.filter((f) => f.indirect.length > 0).length).toBeGreaterThan(120);
    expect(new Set(FIXTURES.map((f) => f.lang))).toEqual(new Set(['en', 'es']));
    const places = new Set(FIXTURES.flatMap((f) => f.places));
    for (const p of ['San Juan', 'Santa María', 'Marbella']) expect(places.has(p)).toBe(true);
    // Fictional owners only (no real business or number).
    expect(FIXTURES.every((f) => /\.(example|test)$/.test(f.owner.domain))).toBe(true);
    expect(FIXTURES.every((f) => f.phoneDigits.every((d) => d.slice(1, 4) === '555'))).toBe(true);
    // Deterministic: the same seed gives the same set.
    expect(sanitizerFixtures(3).map((f) => f.description)).toEqual(FIXTURES.slice(0, 3).map((f) => f.description));
  });

  it('[S12-03] deterministic pass: no direct contact detail left in any of the 200, facts unchanged', () => {
    const failures: string[] = [];
    for (const f of FIXTURES) {
      const out = deterministicSanitizer(plainText(f.description), { ...f.identity, ownerRefs: [f.ref] });
      const leaks = [...fixtureLeaks(f, out, { indirect: false }), ...whiteLabelLeaks(out, f.owner)];
      const missing = missingFacts(f, out);
      if (leaks.length > 0 || missing.length > 0) {
        failures.push(`#${f.index}: leaks ${leaks.join(', ')} · missing ${missing.join(', ')}\n  ${out}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('[S12-03] deterministic + model pass: the 200 are cleaned with zero leaks (indirect mentions too), facts unchanged', async () => {
    const provider = plantedModel();
    gatewayWith(provider);
    const failures: string[] = [];
    for (const f of FIXTURES) {
      const out = await servedWithModel(f);
      const leaks = [...fixtureLeaks(f, out, { indirect: true }), ...whiteLabelLeaks(out, f.owner)];
      const missing = missingFacts(f, out);
      if (leaks.length > 0 || missing.length > 0) {
        failures.push(`#${f.index}: leaks ${leaks.join(', ')} · missing ${missing.join(', ')}\n  ${out}`);
      }
    }
    expect(failures).toEqual([]);
    // Data minimization: the provider saw the deterministic pass's output only — never the owner's contacts.
    const sent = provider.calls.map((c) => c.user).join('\n');
    for (const f of FIXTURES.slice(0, 50)) {
      expect(sent).not.toContain(f.owner.email);
      expect(sent.replace(/\D/g, '')).not.toContain(f.owner.phoneDigits);
    }
    expect(provider.calls[0]?.jsonSchema).toBeDefined();
    // Prompt injection: each text goes as an escaped, nonce-tagged untrusted block, and the prompt says what they are.
    expect(provider.calls[0]?.user).toMatch(/<untrusted_listing_text_[0-9a-f]{16}>/);
    expect(provider.calls[0]?.system).toContain(UNTRUSTED_TEXT_RULE);
  });

  it('[S12-03] the model pass asks once per text (gateway cache) under its feature and prompt version', async () => {
    const provider = plantedModel();
    gatewayWith(provider);
    const f = FIXTURES.find((x) => x.indirect.length > 0) as SanitizerFixture;
    await servedWithModel(f);
    await servedWithModel(f);
    expect(provider.calls).toHaveLength(1);
    expect(WHITE_LABEL_FEATURE).toBe('white-label.sanitize');
    expect(WHITE_LABEL_PROMPT.version).toBe(1);
  });

  it('[S12-03] model answers are checked: facts, absent parts, cut words and over-removal never change the text', () => {
    const text = 'Villa with 3 bedrooms and a pool, 450.000 €. Ask for Maria at our office. Built in 2004 on 900 m2.';
    expect(acceptRemovals(text, ['Ask for Maria at our office.'])).toEqual(['Ask for Maria at our office.']);
    // A fact (rooms, price, area, year: any digit) is never removed; a part not in the text is ignored.
    expect(acceptRemovals(text, ['3 bedrooms', '450.000 €', 'on 900 m2', 'Built in 2004', 'Call Pedro'])).toEqual([]);
    // Whole words only: a part never cuts a word, and one short word (under 4 characters) is never enough.
    expect(acceptRemovals(text, ['Maria at our offi', 'and', 'pool'])).toEqual(['pool']);
    // Whitespace may differ (the text's own spacing is kept for the rest).
    expect(acceptRemovals(text, ['Ask  for Maria\nat our office.'])).toHaveLength(1);
    // Removing most of the text: the whole answer is dropped (deterministic only).
    expect(acceptRemovals(text, ['Villa with', 'and a pool,', 'Ask for Maria at our office.', 'Built in'])).toBeNull();
    expect(applyRemovals(text, ['Ask for Maria at our office.'])).toBe(
      'Villa with 3 bedrooms and a pool, 450.000 €. Built in 2004 on 900 m2.',
    );
  });

  it('[S12-03] place and development names and facts in words are never removed (first names inside place names)', () => {
    const text =
      'Villa in Santa María with two bedrooms and a view of San Juan. Ask for María at our office. Near Marbella.';
    const guard = { protectedNames: ['Santa María', 'San Juan', 'Marbella'] };
    // A first name inside a place name, a short word of one, a part across one, a fact in words: all dropped.
    expect(acceptRemovals(text, ['María', 'Juan', 'Mar', 'Santa', 'view of San Juan', 'two bedrooms'], guard)).toEqual(
      [],
    );
    expect(acceptRemovals('Tiene tres dormitorios y two-storey annex.', ['tres dormitorios', 'two-storey'])).toEqual(
      [],
    );
    // The agent's own mention stays removable; the places stay in the text.
    const kept = acceptRemovals(text, ['Ask for María at our office.'], guard) ?? [];
    expect(applyRemovals(text, kept)).toBe(
      'Villa in Santa María with two bedrooms and a view of San Juan. Near Marbella.',
    );
    // The guard's names come from the document's place and development.
    expect(
      protectedNamesOf({
        place: {
          country: { name: 'Spain' },
          region: null,
          city: { name: 'San Juan' },
          area: { name: 'Mar de Cristal' },
        },
        development: { name: 'Santa María Gardens' },
      }),
    ).toEqual(['Spain', 'San Juan', 'Mar de Cristal', 'Santa María Gardens']);
  });

  it('[S12-03] parts are checked on the same whole text they are applied to (a long text is sent in part)', () => {
    const tail = 'Ask for Inge at our Torrox office.';
    const long = `${'A sunny villa with a large garden and sea views. '.repeat(160)}${tail}`;
    const texts = prepareTexts(compileOwner(NO_OWNER), [], [long]);
    expect(texts[0]?.sent.length).toBeLessThan(long.length);
    expect(modelInput(texts)).not.toContain('Inge');
    // A part beyond the part sent still occurs in the whole text: checked and applied there.
    expect(removalsByText(texts, [tail])[texts[0]?.key ?? '']).toEqual([tail]);
  });

  it('[S12-03] no ReDoS: 20,000-character adversarial texts are cleaned in under 50 ms each', () => {
    const owner = sanitizerFixture(0);
    const matcher = compileOwner(owner.identity);
    const inputs = [
      'a'.repeat(20_000),
      'a.'.repeat(10_000),
      'a@'.repeat(10_000),
      `${'a'.repeat(19_990)}@b`,
      `x@${'a-'.repeat(9_995)}`,
      `x@${'a.'.repeat(9_995)}`,
      'info [at] '.repeat(2_000),
      'a at b dot '.repeat(1_800),
      'a arroba b punto '.repeat(1_100),
      'a @ b . '.repeat(2_500),
      `${' '.repeat(19_990)}@`,
      '1 '.repeat(10_000),
      '1.2.'.repeat(5_000),
      '@a'.repeat(10_000),
      'B1234567 '.repeat(2_200),
      'www.'.repeat(5_000),
      'María '.repeat(3_300),
    ];
    const slow: string[] = [];
    for (const input of inputs) {
      const t0 = performance.now();
      matcher.clean(input, [owner.ref]);
      acceptRemovals(input, ['a a a', 'María María'], { protectedNames: ['Santa María'] });
      const ms = performance.now() - t0;
      if (ms >= 50) slow.push(`${JSON.stringify(input.slice(0, 12))}…: ${ms.toFixed(1)} ms`);
    }
    expect(slow).toEqual([]);
  });

  it('[S12-03] the model pass asks only for documents network sites show', () => {
    const doc = { public: true, status: 'ACTIVE', networkHidden: false };
    expect(shownOnNetwork(doc)).toBe(true);
    expect(shownOnNetwork({ ...doc, public: false })).toBe(false);
    expect(shownOnNetwork({ ...doc, networkHidden: true })).toBe(false);
    expect(shownOnNetwork({ ...doc, status: 'DRAFT' })).toBe(false);
    expect(shownOnNetwork({ ...doc, status: 'SOLD' })).toBe(false);
  });

  it('[S12-03] removals apply to the source text they were made for only (a new version is deterministic-only)', () => {
    const f = FIXTURES.find((x) => x.indirect.length > 0) as SanitizerFixture;
    const matcher = compileOwner(f.identity);
    const marker = (f.indirect[0]?.marker ?? '').toLowerCase();
    const removals = new Map([[textKey(plainText(f.description)), [f.indirect[0]?.sentence ?? '']]]);
    expect(whiteLabelText(f.description, matcher, [f.ref], removals).toLowerCase()).not.toContain(marker);
    const edited = `${f.description} New kitchen.`;
    expect(whiteLabelText(edited, matcher, [f.ref], removals).toLowerCase()).toContain(marker);
  });

  it('[S12-03] model unavailable, over budget or answering badly: null (the text stays deterministic-only)', async () => {
    const f = FIXTURES.find((x) => x.indirect.length > 0) as SanitizerFixture;
    const texts = prepareTexts(compileOwner(f.identity), [f.ref], [f.description]);
    // No gateway configured (an API process): AI_UNAVAILABLE.
    const codes: string[] = [];
    expect(await modelRemovals(ctx, texts, (c) => codes.push(c))).toBeNull();
    gatewayWith(new FakeProvider().failWith());
    expect(await modelRemovals(ctx, texts, (c) => codes.push(c))).toBeNull();
    gatewayWith(plantedModel(), { hardMicroUsd: 0 });
    expect(await modelRemovals(ctx, texts, (c) => codes.push(c))).toBeNull();
    gatewayWith(new FakeProvider(() => 'not json at all'));
    expect(await modelRemovals(ctx, texts, (c) => codes.push(c))).toBeNull();
    expect(codes).toEqual(['AI_UNAVAILABLE', 'AI_UNAVAILABLE', 'AI_BUDGET_EXCEEDED', 'AI_OUTPUT_INVALID']);
    // Served deterministic-only: direct contacts still gone, facts unchanged.
    const out = whiteLabelText(f.description, compileOwner(f.identity), [f.ref]);
    expect(fixtureLeaks(f, out, { indirect: false })).toEqual([]);
    expect(missingFacts(f, out)).toEqual([]);
  });

  it('[S12-03] the prompt treats the texts as untrusted data', () => {
    const prompt = readFileSync(`${PROMPTS_DIR}/white-label/v1.md`, 'utf8');
    expect(prompt).toContain(UNTRUSTED_TEXT_RULE);
  });

  it('[S12-03] recorded live answers (evals/white-label, an injection case too): zero leaks, facts unchanged', () => {
    const cases = readFileSync(EVALS_FILE, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .map((l) => EvalCase.parse(JSON.parse(l)));
    expect(cases.length).toBeGreaterThanOrEqual(5);
    expect(cases.length).toBeLessThanOrEqual(10);
    expect(cases.some((c) => c.name.startsWith('injection'))).toBe(true);
    const failures: string[] = [];
    for (const c of cases) {
      const texts = blocksOf(c.input as string);
      expect(texts.length, c.name).toBeGreaterThan(0);
      const index = /^fixture #(\d+)/.exec(c.name)?.[1];
      const guard = { protectedNames: index === undefined ? [] : sanitizerFixture(Number(index)).places };
      const answer = c.recorded[String(WHITE_LABEL_PROMPT.version)];
      expect(answer, c.name).toBeDefined();
      const raw = (answer ?? '').trim().replace(/^```(?:json)?\s*\n?|\n?```$/g, '');
      const { remove } = JSON.parse(raw) as { remove: string[] };
      const prepared = texts.map((t) => ({ key: textKey(t), clean: t, sent: t }));
      const byText = removalsByText(prepared, remove, guard);
      for (const t of prepared) {
        const out = applyRemovals(t.clean, byText[t.key] ?? []);
        const lower = out.toLowerCase();
        for (const marker of c.checks.contains ?? []) {
          if (lower.includes(marker.toLowerCase())) failures.push(`${c.name}: left "${marker}"`);
        }
        for (const fact of c.checks.notContains ?? []) {
          if (t.clean.includes(fact) && !out.includes(fact)) failures.push(`${c.name}: lost fact "${fact}"`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('[S12-03] the texts of a document the serializer white-labels are the ones the model pass sees', () => {
    const texts = docTexts({
      title: 'Villa',
      description: 'Ask for Maria',
      metaTitle: null,
      metaDescription: '',
      paymentTerms: '30% on signing',
      development: { name: 'Mar Azul' },
      phase: { name: 'Phase 1' },
      ref: 'X',
    });
    expect(texts).toEqual(['Villa', 'Ask for Maria', '30% on signing', 'Mar Azul', 'Phase 1']);
  });
});
