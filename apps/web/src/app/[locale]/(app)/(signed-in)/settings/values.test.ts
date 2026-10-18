import { UpdateAgencySettingsBody } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import { parseHundredths, settingsValues } from './values';

describe('settings form values', () => {
  it('[S1-06] amounts and percentages parse to hundredths with one unambiguous rule', () => {
    expect(parseHundredths('3,5')).toBe(350);
    expect(parseHundredths('3.5')).toBe(350);
    expect(parseHundredths('3.25')).toBe(325);
    expect(parseHundredths('5000')).toBe(500_000);
    expect(parseHundredths('5000,50')).toBe(500_050);
    expect(parseHundredths(' 12 ')).toBe(1_200);
  });

  it('[S1-06] thousands separators are refused, not guessed ("5.000", "5.000,50")', () => {
    for (const raw of ['5.000', '5.000,50', '5,000.50', '1.234.567', '3.', ',5', '-3', '3e2', '', 'abc']) {
      expect(parseHundredths(raw), raw).toBeNaN();
    }
    // NaN never passes the contract: the save is refused with VALIDATION_FAILED.
    const body = {
      version: 1,
      defaultCommission: {
        type: 'FIXED',
        amount: { amountCents: parseHundredths('5.000'), currency: 'EUR' },
        includesVat: false,
      },
      defaultSplitBp: 5000,
      registrationValidityDays: 180,
      viewingResponseDays: 3,
      enabledLocales: ['es'],
      whiteLabel: { referencePrefix: null, showPoweredBy: true, emailSenderName: null },
      clientMode: { pinMinLength: 4, pinMaxAttempts: 5 },
    };
    expect(UpdateAgencySettingsBody.safeParse(body).success).toBe(false);
  });

  it('[S1-06-F1] the split shows as a percentage and goes back as basis points', () => {
    const values = settingsValues({
      defaultCommission: { type: 'PCT', basisPoints: 500, includesVat: false },
      defaultSplitBp: 5000,
      currency: 'EUR',
      registrationValidityDays: 180,
      viewingResponseDays: 3,
      enabledLocales: ['es'],
      whiteLabel: { referencePrefix: null, showPoweredBy: true, emailSenderName: null },
      clientMode: { pinMinLength: 4, pinMaxAttempts: 5 },
      version: 1,
      updatedAt: new Date(0).toISOString(),
    });
    expect(values).toMatchObject({ commissionType: 'PCT', commissionPercent: '5', splitPercent: '50' });
    expect(parseHundredths(values.splitPercent)).toBe(5000);
    expect(parseHundredths('33,33')).toBe(3333);
  });
});
