import { describe, expect, it } from 'vitest';
import { encodeForm, signStripePayload, verifyStripeSignature, WEBHOOK_TOLERANCE_SECONDS } from '../stripe';

const SECRET = 'whsec_unit0123456789abcdef';
const NOW = 1_800_000_000_000;
const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', data: { object: { id: 'in_1' } } });

describe('Stripe webhook signatures', () => {
  it('[S13-01] accepts a signature made with the endpoint secret over the raw body', () => {
    const header = signStripePayload(body, SECRET, NOW);
    expect(verifyStripeSignature(Buffer.from(body), header, SECRET, NOW)).toMatchObject({ id: 'evt_1' });
  });

  it('[S13-01] accepts any matching v1 among several (secret rotation)', () => {
    const header = signStripePayload(body, SECRET, NOW);
    const other = signStripePayload(body, 'whsec_other0123456789', NOW).split(',')[1];
    expect(
      verifyStripeSignature(Buffer.from(body), `${header.split(',')[0]},${other},${header.split(',')[1]}`, SECRET, NOW),
    ).not.toBeNull();
  });

  it('[S13-01] refuses another secret, a changed body, a replay outside the tolerance and malformed headers', () => {
    const header = signStripePayload(body, SECRET, NOW);
    expect(verifyStripeSignature(Buffer.from(body), header, 'whsec_wrong0123456789', NOW)).toBeNull();
    expect(verifyStripeSignature(Buffer.from(`${body} `), header, SECRET, NOW)).toBeNull();
    expect(
      verifyStripeSignature(Buffer.from(body), header, SECRET, NOW + (WEBHOOK_TOLERANCE_SECONDS + 1) * 1000),
    ).toBeNull();
    expect(verifyStripeSignature(Buffer.from(body), undefined, SECRET, NOW)).toBeNull();
    expect(verifyStripeSignature(Buffer.from(body), 'v1=abc', SECRET, NOW)).toBeNull();
    expect(verifyStripeSignature(Buffer.from(body), header.replace(/v1=/, 'v0='), SECRET, NOW)).toBeNull();
    const notJson = 'not json';
    expect(
      verifyStripeSignature(Buffer.from(notJson), signStripePayload(notJson, SECRET, NOW), SECRET, NOW),
    ).toBeNull();
  });
});

describe('Stripe form encoding', () => {
  it('[S13-01] nests objects and arrays the way Stripe reads them', () => {
    const form = new URLSearchParams(
      encodeForm({
        mode: 'subscription',
        line_items: [{ price: 'price_1', quantity: 1 }],
        payment_method_types: ['card', 'sepa_debit'],
        automatic_tax: { enabled: true },
        skipped: undefined,
      }),
    );
    expect(Object.fromEntries(form)).toEqual({
      mode: 'subscription',
      'line_items[0][price]': 'price_1',
      'line_items[0][quantity]': '1',
      'payment_method_types[0]': 'card',
      'payment_method_types[1]': 'sepa_debit',
      'automatic_tax[enabled]': 'true',
    });
  });
});
