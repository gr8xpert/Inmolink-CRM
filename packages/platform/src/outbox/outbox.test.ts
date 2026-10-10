import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEvent, SubscriberRegistry } from './index';

const updated = defineEvent(
  'properties.listing.updated',
  1,
  z.object({ listingId: z.uuid(), version: z.number().int() }),
);
const id = '0190c6d4-6f1a-7a2b-8c3d-4e5f60718293';

describe('outbox events', () => {
  it('[S0-06] defineEvent builds validated messages', () => {
    expect(updated({ listingId: id, version: 2 })).toEqual({
      type: 'properties.listing.updated',
      version: 1,
      payload: { listingId: id, version: 2 },
    });
    expect(() => updated({ listingId: 'nope', version: 2 })).toThrow();
  });

  it('[S0-06] defineEvent rejects malformed types and versions', () => {
    expect(() => defineEvent('Listing Updated', 1, z.object({}))).toThrow(/invalid event type/);
    expect(() => defineEvent('nodots', 1, z.object({}))).toThrow(/invalid event type/);
    expect(() => defineEvent('a.b', 0, z.object({}))).toThrow(/positive integer/);
  });

  it('[S0-06] subscribers are keyed by type and version, and can unsubscribe', () => {
    const reg = new SubscriberRegistry();
    const v2 = defineEvent('properties.listing.updated', 2, z.object({}));
    const off = reg.add(updated, () => {});
    reg.add(v2, () => {}, 'v2-consumer');
    expect(reg.get(updated.type, 1)).toHaveLength(1);
    expect(reg.get(updated.type, 2).map((s) => s.name)).toEqual(['v2-consumer']);
    off();
    expect(reg.get(updated.type, 1)).toHaveLength(0);
  });
});
