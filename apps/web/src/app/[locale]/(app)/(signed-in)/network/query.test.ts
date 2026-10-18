import { NetworkSearchBody } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import { networkBody, networkSearch, parseNetworkState } from './query';

const TYPE = '01900000-0000-7000-8000-000000000001';

describe('network search URL state', () => {
  it('[S5-05] filters incl. preferred agencies only and new-builds become a valid API body', () => {
    const s = parseNetworkState({
      q: ' sea view ',
      preferred: '1',
      newBuilds: '1',
      type: TYPE,
      min: '250000',
      max: '900000',
      beds: '3',
      sort: 'price_asc',
      view: 'map',
    });
    const body = networkBody(s);
    expect(body).toEqual({
      text: 'sea view',
      newBuilds: true,
      preferredOnly: true,
      propertyTypeIds: [TYPE],
      priceMinCents: 25_000_000,
      priceMaxCents: 90_000_000,
      bedsMin: 3,
      sort: 'price_asc',
      limit: 50,
    });
    expect(NetworkSearchBody.safeParse(body).success).toBe(true);
    expect(parseNetworkState(Object.fromEntries(new URLSearchParams(networkSearch(s))))).toEqual(s);
  });

  it('[S5-05] malformed parameters are dropped, not sent', () => {
    const s = parseNetworkState({ type: 'nope', min: '-1', beds: '99', sort: 'random', cursor: '<x>', kind: 'X' });
    expect(networkBody(s)).toEqual({ newBuilds: false, preferredOnly: false, sort: 'newest', limit: 24 });
    expect(networkSearch(s, { view: 'map', cursor: undefined })).toBe('view=map');
  });
});
