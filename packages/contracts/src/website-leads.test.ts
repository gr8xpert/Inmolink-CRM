import { describe, expect, it } from 'vitest';
import { IdempotencyKey, LEAD_LIMITS, WebsiteLeadBody, WebsiteViewingRequestBody } from './website-leads';

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
