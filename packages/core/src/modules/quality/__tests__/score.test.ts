import { QUALITY_COMPONENTS } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import { type QualityFacts, scoreListing } from '../score';

const NOW = new Date('2026-10-16T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const sharp = { width: 2048, height: 1365 };
const small = { width: 800, height: 600 };

/** A listing with everything the score asks for. */
const complete = (over: Partial<QualityFacts> = {}): QualityFacts => ({
  images: Array.from({ length: 15 }, () => sharp),
  descriptions: [
    { locale: 'es', length: 900 },
    { locale: 'en', length: 850 },
  ],
  locales: ['es', 'en'],
  status: 'ACTIVE',
  hasCoordinates: true,
  locationPrecision: 'EXACT',
  energyRating: 'C',
  lastConfirmedAt: daysAgo(10),
  networkHiddenAt: null,
  now: NOW,
  ...over,
});
const codes = (facts: QualityFacts) => scoreListing(facts).hints.map((h) => h.code);

describe('quality score', () => {
  it('[S3-08] a complete, fresh listing scores 100 with no hints; the parts add up to the score', () => {
    const r = scoreListing(complete());
    expect(r.score).toBe(100);
    expect(r.hints).toEqual([]);
    expect(r.components.map((c) => [c.key, c.points, c.max])).toEqual(
      Object.entries(QUALITY_COMPONENTS).map(([k, max]) => [k, max, max]),
    );
  });

  it('[S3-08] an empty listing gets one hint per missing part, biggest gain first, each pointing at its section', () => {
    const r = scoreListing(complete({ images: [], descriptions: [], hasCoordinates: false, energyRating: null }));
    // Only freshness (10) earned: no photos, no description, no translations, no pin, no CEE rating.
    expect(r.score).toBe(10);
    expect(r.hints.map((h) => [h.code, h.section, h.gain])).toEqual([
      ['PHOTOS_FEW', 'media', 25],
      ['DESCRIPTION_SHORT', 'translations', 20],
      ['TRANSLATIONS_MISSING', 'translations', 15],
      ['LOCATION_MISSING', 'location', 10],
      ['ENERGY_RATING_MISSING', 'specs', 10],
    ]);
    expect(r.hints.find((h) => h.code === 'TRANSLATIONS_MISSING')?.params).toEqual({ count: 2, locales: 'es, en' });
  });

  it('[S3-08] more photos score more; photos still processing are not held against resolution', () => {
    const three = scoreListing(complete({ images: [null, null, null] }));
    const six = scoreListing(complete({ images: [null, null, null, null, null, null] }));
    expect(six.score).toBeGreaterThan(three.score);
    expect(three.pendingPhotos).toBe(3);
    expect(three.components.find((c) => c.key === 'resolution')?.points).toBe(QUALITY_COMPONENTS.resolution);
    expect(three.hints[0]).toMatchObject({ code: 'PHOTOS_FEW', params: { count: 3, target: 15 } });
  });

  it('[S3-08] low-resolution photos lower the resolution part in proportion and name how many', () => {
    const r = scoreListing(
      complete({ images: [...Array.from({ length: 10 }, () => sharp), ...Array.from({ length: 5 }, () => small)] }),
    );
    expect(r.components.find((c) => c.key === 'resolution')?.points).toBe(7);
    expect(r.hints).toEqual([
      expect.objectContaining({ code: 'PHOTOS_LOW_RES', gain: 3, params: { count: 5, minPx: 1280 } }),
    ]);
  });

  it('[S3-08] description length, missing languages, an approximate pin and a PENDING rating each cost points', () => {
    expect(
      scoreListing(
        complete({
          descriptions: [
            { locale: 'es', length: 400 },
            { locale: 'en', length: 0 },
          ],
        }),
      ).score,
    ).toBe(100 - 10 - 7); // half the description (10 of 20), one language of two (8 of 15)
    expect(codes(complete({ locationPrecision: 'APPROX' }))).toEqual(['LOCATION_APPROX']);
    expect(scoreListing(complete({ locationPrecision: 'APPROX' })).score).toBe(96);
    expect(codes(complete({ energyRating: 'PENDING' }))).toEqual(['ENERGY_RATING_MISSING']);
    expect(scoreListing(complete({ energyRating: 'EXEMPT' })).score).toBe(100);
  });

  it('[S3-08] freshness: full until 90 days, half until 120, nothing after or while hidden from the network', () => {
    expect(scoreListing(complete({ lastConfirmedAt: daysAgo(89) })).score).toBe(100);
    const due = scoreListing(complete({ lastConfirmedAt: daysAgo(95) }));
    expect(due.score).toBe(95);
    expect(due.hints).toEqual([
      expect.objectContaining({ code: 'CONFIRMATION_DUE', section: 'freshness', params: { days: 95 } }),
    ]);
    expect(scoreListing(complete({ lastConfirmedAt: daysAgo(121) })).score).toBe(90);
    expect(codes(complete({ lastConfirmedAt: daysAgo(130), networkHiddenAt: daysAgo(10) }))).toEqual([
      'NETWORK_HIDDEN',
    ]);
  });

  it('[S3-08] freshness counts only for ACTIVE listings: an old draft is not prompted', () => {
    expect(scoreListing(complete({ status: 'DRAFT', lastConfirmedAt: daysAgo(200) })).score).toBe(100);
    expect(codes(complete({ status: 'WITHDRAWN', lastConfirmedAt: daysAgo(95) }))).toEqual([]);
  });
});
