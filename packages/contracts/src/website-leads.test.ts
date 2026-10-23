import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LEAD_LIMITS, WEBSITE_LEAD_TURNSTILE_ACTION } from './values';
import { IdempotencyKey, WebsiteLeadBody, WebsiteViewingRequestBody } from './website-leads';

const base = { name: 'Ana Buyer', email: ' Ana@Example.com ', privacyAccepted: true };
const ok = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown) => schema.safeParse(v).success;

describe('website lead contracts (S7-05)', () => {
  it('[S7-05] a lead is validated and size-capped field by field', () => {
    const parsed = WebsiteLeadBody.parse({ ...base, message: 'Hello\nIs it free?' });
    expect(parsed).toMatchObject({ email: 'ana@example.com', marketingConsent: false, message: 'Hello\nIs it free?' });
    expect(ok(WebsiteLeadBody, { ...base, name: 'x'.repeat(LEAD_LIMITS.name + 1) })).toBe(false);
    expect(ok(WebsiteLeadBody, { ...base, name: 'Visit www.spam.example' })).toBe(false);
    expect(ok(WebsiteLeadBody, { ...base, name: 'Ana <script>' })).toBe(false);
    expect(ok(WebsiteLeadBody, { ...base, name: 'Ana\u0000' })).toBe(false);
    expect(ok(WebsiteLeadBody, { ...base, message: 'x'.repeat(LEAD_LIMITS.message + 1) })).toBe(false);
    expect(ok(WebsiteLeadBody, { ...base, message: 'bell \u0007' })).toBe(false);
    expect(ok(WebsiteLeadBody, { ...base, phone: '+34 600 000 000' })).toBe(true);
    expect(ok(WebsiteLeadBody, { ...base, phone: 'call me maybe' })).toBe(false);
    expect(ok(WebsiteLeadBody, { ...base, pageUrl: 'https://www.site.example/villa' })).toBe(true);
    expect(ok(WebsiteLeadBody, { ...base, pageUrl: 'http://www.site.example/villa' })).toBe(false);
    expect(ok(WebsiteLeadBody, { ...base, pageUrl: 'javascript:alert(1)' })).toBe(false);
    expect(ok(WebsiteLeadBody, { ...base, privacyAccepted: false })).toBe(false);
    expect(ok(WebsiteLeadBody, { ...base, serverVerified: false })).toBe(false);
    expect(ok(WebsiteLeadBody, { ...base, turnstileToken: 'x'.repeat(LEAD_LIMITS.turnstileToken + 1) })).toBe(false);
    expect(ok(WebsiteLeadBody, { ...base, ref: 'has space' })).toBe(false);
    expect(ok(WebsiteLeadBody, { ...base, admin: true })).toBe(false);
  });

  it('[S7-05] a viewing request names a listing and one to three distinct slots', () => {
    const slot = { date: '2026-11-02', timeOfDay: 'MORNING' };
    expect(ok(WebsiteViewingRequestBody, { ...base, ref: 'CH-7KQ2M9XA', slots: [slot] })).toBe(true);
    expect(ok(WebsiteViewingRequestBody, { ...base, slots: [slot] })).toBe(false);
    expect(ok(WebsiteViewingRequestBody, { ...base, ref: 'CH-1', slots: [] })).toBe(false);
    expect(ok(WebsiteViewingRequestBody, { ...base, ref: 'CH-1', slots: [slot, slot] })).toBe(false);
    expect(
      ok(WebsiteViewingRequestBody, {
        ...base,
        ref: 'CH-1',
        slots: ['02', '03', '04', '05'].map((d) => ({ date: `2026-11-${d}`, timeOfDay: 'ANY' })),
      }),
    ).toBe(false);
    expect(
      ok(WebsiteViewingRequestBody, { ...base, ref: 'CH-1', slots: [{ date: '2026-13-40', timeOfDay: 'ANY' }] }),
    ).toBe(false);
  });

  it('[S7-05] idempotency keys are 16–128 safe characters', () => {
    expect(ok(IdempotencyKey, '0b9a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d')).toBe(true);
    expect(ok(IdempotencyKey, 'short')).toBe(false);
    expect(ok(IdempotencyKey, 'x'.repeat(129))).toBe(false);
    expect(ok(IdempotencyKey, 'has spaces in the key!!')).toBe(false);
  });
});

/** The WordPress plugin runs the same file in PHPUnit (`tests/Integration/LeadFormValidationTest.php`). */
const fixture = JSON.parse(
  readFileSync(new URL('../../../apps/wp-plugin/tests/fixtures/leads/cases.json', import.meta.url), 'utf8'),
) as {
  limits: Record<string, number>;
  turnstileAction: string;
  cases: { id: string; kind: 'enquiry' | 'viewing'; valid: boolean; body: Record<string, unknown> }[];
};
const DAY_MS = 86_400_000;
type Repeat = { $repeat: string; times: number; $prefix?: string };
const isRepeat = (v: unknown): v is Repeat => typeof v === 'object' && v !== null && '$repeat' in v;
const text = (v: unknown): unknown => (isRepeat(v) ? (v.$prefix ?? '') + v.$repeat.repeat(v.times) : v);
function resolve(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) out[k] = text(v);
  if (Array.isArray(out.slots)) {
    out.slots = (out.slots as Record<string, unknown>[]).map(({ dayOffset, ...slot }) =>
      typeof dayOffset === 'number'
        ? {
            ...slot,
            date: new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS + dayOffset * DAY_MS).toISOString().slice(0, 10),
          }
        : slot,
    );
  }
  return out;
}

describe('lead validation shared with the WordPress plugin (S9-F5)', () => {
  it('[S9-F5] the plugin fixture states the contract limits and the Turnstile action', () => {
    expect(fixture.limits).toEqual({
      name: LEAD_LIMITS.name,
      email: LEAD_LIMITS.email,
      phone: LEAD_LIMITS.phone,
      message: LEAD_LIMITS.message,
      pageUrl: LEAD_LIMITS.pageUrl,
    });
    expect(LEAD_LIMITS.phone).toBe(25);
    expect(fixture.turnstileAction).toBe(WEBSITE_LEAD_TURNSTILE_ACTION);
  });

  it('[S9-F5] phone allows exactly LEAD_LIMITS.phone characters, with or without a plus', () => {
    expect(ok(WebsiteLeadBody, { ...base, phone: `+${'6'.repeat(LEAD_LIMITS.phone - 1)}` })).toBe(true);
    expect(ok(WebsiteLeadBody, { ...base, phone: '6'.repeat(LEAD_LIMITS.phone - 1) })).toBe(true);
    expect(ok(WebsiteLeadBody, { ...base, phone: '6'.repeat(LEAD_LIMITS.phone) })).toBe(false);
  });

  it('[S9-F5] every fixture case gets its verdict from the contract', () => {
    expect(fixture.cases.length).toBeGreaterThan(40);
    const wrong = fixture.cases.filter((c) => {
      const schema = c.kind === 'viewing' ? WebsiteViewingRequestBody : WebsiteLeadBody;
      return ok(schema, resolve(c.body)) !== c.valid;
    });
    expect(wrong.map((c) => c.id)).toEqual([]);
  });
});
