import { describe, expect, it } from 'vitest';
import { CompanyName, parseSpanishTaxId, SpanishTaxId, TAX_ID_MESSAGES, UpdateAgencyDetailsBody } from './agencies';
import { RegisterInput } from './identity';

describe('Spanish tax ids', () => {
  it('[S1-01] CIF/NIF format validated (Spanish rules) with a clear error — valid numbers', () => {
    expect(parseSpanishTaxId('12345678Z')).toEqual({ ok: true, kind: 'NIF', value: '12345678Z' });
    expect(parseSpanishTaxId('00000000T')).toEqual({ ok: true, kind: 'NIF', value: '00000000T' });
    expect(parseSpanishTaxId('X1234567L')).toEqual({ ok: true, kind: 'NIE', value: 'X1234567L' });
    expect(parseSpanishTaxId('Y1234567X')).toEqual({ ok: true, kind: 'NIE', value: 'Y1234567X' });
    expect(parseSpanishTaxId('B12345674')).toEqual({ ok: true, kind: 'CIF', value: 'B12345674' });
    // Letter-control CIF (public body), and an either-control entity letter written both ways.
    expect(parseSpanishTaxId('Q2826000H')).toEqual({ ok: true, kind: 'CIF', value: 'Q2826000H' });
    expect(parseSpanishTaxId('G12345674')).toMatchObject({ ok: true });
    expect(parseSpanishTaxId('G1234567D')).toMatchObject({ ok: true });
  });

  it('[S1-01] CIF/NIF format validated (Spanish rules) with a clear error — normalization', () => {
    expect(parseSpanishTaxId(' b-12.345.674 ')).toMatchObject({ ok: true, value: 'B12345674' });
    expect(parseSpanishTaxId('ESB12345674')).toMatchObject({ ok: true, value: 'B12345674' });
    expect(parseSpanishTaxId('x-1234567-l')).toMatchObject({ ok: true, value: 'X1234567L' });
  });

  it('[S1-01] CIF/NIF format validated (Spanish rules) with a clear error — wrong control character', () => {
    expect(parseSpanishTaxId('12345678A')).toEqual({ ok: false, reason: 'control' });
    expect(parseSpanishTaxId('X1234567A')).toEqual({ ok: false, reason: 'control' });
    expect(parseSpanishTaxId('B12345675')).toEqual({ ok: false, reason: 'control' });
    // A needs a digit control, Q a letter control.
    expect(parseSpanishTaxId('A1234567D')).toEqual({ ok: false, reason: 'control' });
    expect(parseSpanishTaxId('Q28260008')).toEqual({ ok: false, reason: 'control' });
  });

  it('[S1-01] CIF/NIF format validated (Spanish rules) with a clear error — not a tax id at all', () => {
    for (const bad of ['', '1234', 'I12345674', '123456789', 'ZZ1234567', 'B1234567', 'hello world']) {
      expect(parseSpanishTaxId(bad)).toEqual({ ok: false, reason: 'format' });
    }
  });

  it('[S1-01] CIF/NIF format validated (Spanish rules) with a clear error — Zod message and reason', () => {
    expect(SpanishTaxId.parse('b12345674')).toBe('B12345674');
    const control = SpanishTaxId.safeParse('B12345675');
    expect(control.success).toBe(false);
    expect(control.error?.issues[0]).toMatchObject({ message: TAX_ID_MESSAGES.control, params: { reason: 'control' } });
    const format = SpanishTaxId.safeParse('not-a-cif');
    expect(format.error?.issues[0]).toMatchObject({ message: TAX_ID_MESSAGES.format, params: { reason: 'format' } });
  });
});

describe('agency inputs', () => {
  it('[S1-01] company names allow legal suffixes but nothing that renders as a link', () => {
    expect(CompanyName.parse('  Costa Homes S.L. ')).toBe('Costa Homes S.L.');
    expect(CompanyName.parse('García & Hijos, S.A.U.')).toBe('García & Hijos, S.A.U.');
    for (const bad of ['evil.example', 'Visit costa.com now', '<b>Homes</b>', 'x']) {
      expect(CompanyName.safeParse(bad).success).toBe(false);
    }
  });

  it('[S1-01] sign-up needs an account kind (AGENCY or DEVELOPER) and a company name', () => {
    const base = { email: 'a@b.es', password: 'correct horse battery', name: 'Ana', locale: 'es' };
    expect(RegisterInput.safeParse(base).success).toBe(false);
    expect(RegisterInput.safeParse({ ...base, accountKind: 'PARTNER', companyName: 'Costa' }).success).toBe(false);
    expect(RegisterInput.parse({ ...base, accountKind: 'DEVELOPER', companyName: 'Nova Obra' })).toMatchObject({
      accountKind: 'DEVELOPER',
    });
  });

  it('[S1-01] onboarding validates postal code, region and languages', () => {
    const ok = {
      version: 1,
      name: 'Costa Homes',
      taxId: 'B12345674',
      addressLine: 'Calle Mayor 1',
      city: 'Marbella',
      postalCode: '29601',
      region: 'ES-AN',
      languages: ['es'],
    };
    expect(UpdateAgencyDetailsBody.safeParse(ok).success).toBe(true);
    expect(UpdateAgencyDetailsBody.safeParse({ ...ok, postalCode: '60000' }).success).toBe(false);
    expect(UpdateAgencyDetailsBody.safeParse({ ...ok, region: 'ES-XX' }).success).toBe(false);
    expect(UpdateAgencyDetailsBody.safeParse({ ...ok, languages: [] }).success).toBe(false);
    expect(UpdateAgencyDetailsBody.safeParse({ ...ok, languages: ['es', 'es'] }).success).toBe(false);
    expect(UpdateAgencyDetailsBody.safeParse({ ...ok, status: 'VERIFIED' }).success).toBe(false);
  });
});
