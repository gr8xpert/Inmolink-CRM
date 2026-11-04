import { CreateNetworkPostBody } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import { postErrorCode } from './post-errors';

const base = { kind: 'BUYER_REQUEST', title: 'Villa wanted', body: 'Two bedrooms near the sea', criteria: {} };
const codeOf = (patch: Record<string, unknown>) => {
  const r = CreateNetworkPostBody.safeParse({ ...base, ...patch });
  if (r.success) throw new Error('expected a failure');
  return postErrorCode(r.error.issues);
};

describe('[S17-F37] board post errors say what is wrong', () => {
  it('a bad expiry is an expiry error', () => expect(codeOf({ expiresInDays: 9999 })).toBe('VALIDATION_EXPIRY'));
  it('a min above max price is a price error', () =>
    expect(codeOf({ criteria: { priceMinCents: 500, priceMaxCents: 100 } })).toBe('VALIDATION_PRICE'));
  it('contact details are a contact error', () =>
    expect(codeOf({ body: 'call me on +34 600 123 456' })).toBe('VALIDATION_CONTACT'));
  it('an empty title is a text error', () => expect(codeOf({ title: '' })).toBe('VALIDATION_TEXT'));
  it('anything else is the neutral message', () => expect(codeOf({ kind: 'NOPE' })).toBe('VALIDATION_FAILED'));
});
