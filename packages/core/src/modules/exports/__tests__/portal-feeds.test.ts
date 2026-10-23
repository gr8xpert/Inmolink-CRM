import { XmlWriter } from '@inmolink/platform/xml';
import { describe, expect, it } from 'vitest';
import {
  type FeedItem,
  kyeroBlocker,
  writeGenericEnd,
  writeGenericItem,
  writeGenericStart,
  writeKyeroEnd,
  writeKyeroProperty,
  writeKyeroStart,
} from '../../../feed-xml';
import { buildItems } from '../feed';
import { PORTAL_PROFILES, type PortalProfile, portalWriterEnabled } from '../profiles';
import { validateItem } from '../validate';
import { DESCRIPTION, image, listingDoc, ownDetail, PRESENTER, schemaErrors, xsd } from './portal-fixtures';

/**
 * Portal feed writers and validation (S9-02): each portal's output validates against its schema fixture, and the
 * validator gives per-listing reasons from the portal's profile (data, not code).
 */

const ID = '0195f0a5-0000-7000-8000-0000000000a1';
const build = (doc = listingDoc(), locales = ['en']): FeedItem => {
  const { items } = buildItems([ID], [ownDetail(ID, doc)], {
    locales,
    baseLocale: 'en',
    mediaBase: 'https://media.example/bucket',
    presenter: PRESENTER,
  });
  const item = items[0]?.item;
  if (!item) throw new Error('fixture document did not build');
  return item;
};
const codes = (profile: PortalProfile, item: FeedItem) => validateItem(profile, item).map((i) => i.code);
const kyero = PORTAL_PROFILES.kyero as PortalProfile;
const thinkspain = PORTAL_PROFILES.thinkspain as PortalProfile;
const place = PORTAL_PROFILES['a-place-in-the-sun'] as PortalProfile;
const generic = PORTAL_PROFILES['generic-xml'] as PortalProfile;

function kyeroXml(item: FeedItem, profile: PortalProfile): string {
  const w = new XmlWriter();
  writeKyeroStart(w);
  writeKyeroProperty(w, item, { maxImages: profile.maxPhotos ?? undefined });
  writeKyeroEnd(w);
  return w.end();
}

describe('[S9-02] portal writers validate against their schema fixtures', () => {
  it.each([
    ['kyero', kyero, 'kyero/kyero-v3.xsd'],
    ['thinkspain', thinkspain, 'thinkspain/portal-feed.xsd'],
    ['a-place-in-the-sun', place, 'a-place-in-the-sun/portal-feed.xsd'],
  ])('[S9-02] %s', async (_name, profile, schema) => {
    expect(profile.schema).toBe(schema);
    const item = build();
    expect(validateItem(profile, item)).toEqual([]);
    const xml = kyeroXml(item, profile);
    expect(xml).toContain('<ref>REF-1</ref>');
    expect(await schemaErrors(xml, xsd(schema))).toEqual([]);
  });

  it('[S9-02] generic XML', async () => {
    const item = build();
    const w = new XmlWriter();
    writeGenericStart(w, {
      generatedAt: new Date('2026-10-23T00:00:00Z'),
      siteName: 'Portal',
      locales: ['en'],
      agency: PRESENTER,
    });
    writeGenericItem(w, item);
    writeGenericEnd(w);
    expect(await schemaErrors(w.end(), xsd(generic.schema))).toEqual([]);
  });

  it('[S9-02] images are the processed variants under the media CDN, never storage keys alone', () => {
    const xml = kyeroXml(build(), kyero);
    expect(xml).toContain('<url>https://media.example/bucket/v1/img1/large.webp</url>');
    expect(xml).not.toContain('variants');
  });

  it('[S9-02] a portal photo cap cuts the photos written, never the listing', () => {
    const many = Array.from({ length: 8 }, (_, i) => image(i + 1));
    const xml = kyeroXml(build(listingDoc({ media: many, imageCount: 8 })), { ...kyero, maxPhotos: 3 });
    expect(xml.match(/<image id=/g)).toHaveLength(3);
  });

  it('[S9-02] the stricter portal schemas really reject what the validator refuses (rules and fixtures agree)', async () => {
    const few = build(listingDoc({ media: [image(1), image(2)], imageCount: 2 }));
    expect(codes(thinkspain, few)).toEqual(['PHOTOS_TOO_FEW']);
    expect(await schemaErrors(kyeroXml(few, thinkspain), xsd(thinkspain.schema))).not.toEqual([]);
    expect(await schemaErrors(kyeroXml(few, kyero), xsd(kyero.schema))).toEqual([]);
  });
});

describe('[S9-02] validation gives a reason per listing', () => {
  it('[S9-02] a complete listing passes every portal', () => {
    for (const profile of Object.values(PORTAL_PROFILES)) expect(codes(profile, build())).toEqual([]);
  });

  it('[S9-02] required fields: price, price period, town', () => {
    expect(
      codes(
        kyero,
        build(listingDoc({ price: { amountCents: null, currency: 'EUR', period: null, onRequest: false } })),
      ),
    ).toEqual(['PRICE_MISSING']);
    expect(
      codes(kyero, build(listingDoc({ price: { amountCents: null, currency: 'EUR', period: null, onRequest: true } }))),
    ).toEqual(['PRICE_ON_REQUEST']);
    expect(
      codes(
        kyero,
        build(
          listingDoc({
            transactionType: 'RENT_SHORT_TERM',
            price: { amountCents: 9_000, currency: 'EUR', period: 'NIGHT', onRequest: false },
          }),
        ),
      ),
    ).toEqual(['PRICE_PERIOD']);
    expect(codes(kyero, build(listingDoc({ place: { country: null, region: null, city: null, area: null } })))).toEqual(
      ['TOWN_MISSING'],
    );
  });

  it('[S9-02] CEE energy rating: missing is refused, exempt and in progress are fine, optional for generic XML', () => {
    expect(codes(kyero, build(listingDoc({ energyRating: null })))).toEqual(['ENERGY_RATING_MISSING']);
    expect(codes(kyero, build(listingDoc({ energyRating: 'EXEMPT' })))).toEqual([]);
    expect(codes(kyero, build(listingDoc({ energyRating: 'PENDING' })))).toEqual([]);
    expect(codes(generic, build(listingDoc({ energyRating: null })))).toEqual([]);
  });

  it('[S9-02] minimum photos come from the portal profile, with the numbers', () => {
    const three = build(listingDoc({ media: [image(1), image(2), image(3)], imageCount: 3 }));
    expect(codes(kyero, three)).toEqual([]);
    expect(codes(thinkspain, three)).toEqual([]);
    expect(validateItem(place, three)).toEqual([{ code: 'PHOTOS_TOO_FEW', params: { min: 5, actual: 3 } }]);
    // The threshold is data: a profile with another minimum changes the answer, no code does.
    expect(codes({ ...thinkspain, minPhotos: 4 }, three)).toEqual(['PHOTOS_TOO_FEW']);
  });

  it('[S9-02] description length: missing, too short, too long', () => {
    expect(codes(kyero, build(listingDoc({ description: null })))).toEqual(['DESCRIPTION_MISSING']);
    expect(validateItem(kyero, build(listingDoc({ description: 'Nice villa.' })))).toEqual([
      { code: 'DESCRIPTION_TOO_SHORT', params: { min: 30, actual: 11 } },
    ]);
    expect(codes(kyero, build(listingDoc({ description: 'x'.repeat(20_001) })))).toEqual(['DESCRIPTION_TOO_LONG']);
    expect(codes(generic, build(listingDoc({ description: null })))).toEqual([]);
  });

  it('[S9-02] whatever the Kyero writer would drop is already an issue with the same code (count and list agree)', () => {
    const none = { country: null, region: null, city: null, area: null };
    const cases = [
      listingDoc({ price: { amountCents: null, currency: 'EUR', period: null, onRequest: true } }),
      listingDoc({ price: { amountCents: null, currency: 'EUR', period: null, onRequest: false } }),
      listingDoc({ price: { amountCents: 0, currency: 'EUR', period: null, onRequest: false } }),
      listingDoc({
        transactionType: 'RENT_SHORT_TERM',
        price: { amountCents: 9_000, currency: 'EUR', period: 'NIGHT', onRequest: false },
      }),
      listingDoc({
        transactionType: 'RENT_LONG_TERM',
        price: { amountCents: 90_000, currency: 'EUR', period: 'WEEK', onRequest: false },
      }),
      listingDoc({ place: none }),
    ];
    for (const doc of cases) {
      const item = build(doc);
      const dropped = !writeKyeroProperty(new XmlWriter(), item);
      expect(dropped).toBe(true);
      const blockers = validateItem(kyero, item).map((i) => i.code);
      expect(blockers.length).toBeGreaterThan(0);
      expect(blockers).toContain(kyeroBlocker(item.base));
    }
  });

  it('[S9-02] every reason is reported, not only the first', () => {
    const bad = build(listingDoc({ energyRating: null, description: null, media: [], imageCount: 0, cover: null }));
    expect(codes(kyero, bad).sort()).toEqual(['DESCRIPTION_MISSING', 'ENERGY_RATING_MISSING', 'PHOTOS_TOO_FEW']);
  });

  it('[S9-02] a language counts only where the listing has its own text in it', () => {
    const { items } = buildItems(
      [ID],
      [
        ownDetail(ID, listingDoc({ description: DESCRIPTION })),
        ownDetail(ID, listingDoc({ description: DESCRIPTION, textLocale: 'en' }), 'es'),
      ],
      { locales: ['en', 'es'], baseLocale: 'en', mediaBase: 'https://m.example', presenter: PRESENTER },
    );
    expect([...(items[0]?.item.texts.keys() ?? [])]).toEqual(['en']);
  });
});

describe('[S9-02] unconfirmed portals stay behind a feature flag (H6)', () => {
  it('[S9-02] confirmed formats need none; thinkSPAIN and A Place in the Sun are marked unconfirmed', async () => {
    expect(kyero.confirmed).toBe(true);
    expect(thinkspain.confirmed).toBe(false);
    expect(place.confirmed).toBe(false);
    const ctx = { tx: {} as never, tenant: { agencyId: ID } };
    expect(await portalWriterEnabled(ctx, kyero)).toBe(true);
    expect(await portalWriterEnabled(ctx, null)).toBe(false);
  });
});
