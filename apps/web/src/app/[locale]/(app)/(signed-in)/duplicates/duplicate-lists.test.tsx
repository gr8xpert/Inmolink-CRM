import type { DedupeClusterDto, DedupeListingCard, DedupeReviewDto } from '@inmolink/contracts';
import { loadMessages } from '@inmolink/i18n/server';
import { createTranslator } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ClusterList, ReviewList } from './duplicate-lists';
import { backQuery, doneOf, parseDecision, parseDispute, parseDuplicatesState, viewQuery } from './query';

vi.mock('@/i18n/navigation', () => ({
  Link: (p: { href: unknown; children: unknown }) => <a href={JSON.stringify(p.href)}>{p.children as string}</a>,
}));

const uuid = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const card = (n: number, title: string, ref: string): DedupeListingCard =>
  ({
    kind: 'LISTING',
    id: uuid(n),
    ref,
    status: 'ACTIVE',
    transactionType: 'SALE',
    price: { amountCents: 50_000_000, currency: 'EUR', onRequest: false },
    propertyType: { id: uuid(90), name: 'Villa' },
    place: { country: null, region: null, city: { id: uuid(91), name: 'Marbella' }, area: null },
    bedrooms: 3,
    bathrooms: 2,
    builtM2: 120,
    plotM2: null,
    geo: null,
    cover: null,
    imageCount: 0,
    developmentId: null,
    title,
    slug: 'x',
    textLocale: null,
  }) as never;

const review = (patch: Partial<DedupeReviewDto> = {}): DedupeReviewDto => ({
  id: uuid(1),
  status: 'PENDING',
  score: 0.82,
  signals: { images: 0.5, phash: 0.6, geo: 1, type: 1, beds: 1, baths: null, area: 0.9, price: 1, text: null },
  listing: card(2, 'Our villa', 'OUR-1'),
  other: { network: true, card: card(3, 'Their villa', 'NET-7') },
  decidedAt: null,
  createdAt: '2026-11-07T10:00:00.000Z',
  ...patch,
});

const cluster = (patch: Partial<DedupeClusterDto> = {}): DedupeClusterDto => ({
  listingId: uuid(2),
  clusterId: uuid(5),
  canonical: false,
  via: 'AUTO',
  members: [
    { own: false, network: true, card: card(3, 'Their villa', 'NET-7') },
    { own: true, network: false, card: card(2, 'Our villa', 'OUR-1') },
  ],
  openDispute: null,
  createdAt: '2026-11-07T10:00:00.000Z',
  ...patch,
});

const tOf = (locale: 'en' | 'es') => {
  const t = createTranslator({ locale, messages: loadMessages(locale), namespace: 'listings.duplicates' });
  return (key: string, values?: Record<string, string | number>) => t(key as never, values as never);
};
const shared = (locale: 'en' | 'es') => ({
  t: tOf(locale),
  money: (c: number, cur: string) => `${cur} ${c / 100}`,
  back: { status: 'PENDING' },
});
const pct = (f: number) => `${Math.round(f * 100)}%`;

describe('duplicate listings page (R2-03b)', () => {
  it('[R2-03b] a review shows both listings (the other agency never named), the score and signals, and both decisions', () => {
    const en = renderToStaticMarkup(
      <ReviewList items={[review()]} status="PENDING" percent={pct} decide="/d" {...shared('en')} />,
    );
    expect(en).toContain('Our villa');
    expect(en).toContain('Another agency’s listing');
    expect(en).toContain('82% alike');
    expect(en).toContain('Same photos 50%');
    expect(en).not.toContain('Bathrooms');
    expect(en).toContain('aria-label="Mark OUR-1 and NET-7 as the same property"');
    expect(en).toContain('aria-label="Mark OUR-1 and NET-7 as different properties"');
    expect(en).toContain('name="back.status" value="PENDING"');
    const es = renderToStaticMarkup(
      <ReviewList
        items={[review({ status: 'NOT_DUPLICATE' })]}
        status="NOT_DUPLICATE"
        percent={pct}
        decide="/d"
        {...shared('es')}
      />,
    );
    expect(es).toContain('No duplicados');
    expect(es).not.toContain('Mismo inmueble<');
    expect(
      renderToStaticMarkup(<ReviewList items={[]} status="PENDING" percent={pct} decide="/d" {...shared('en')} />),
    ).toContain('Nothing to review.');
  });

  it('[R2-03b] a grouped listing shows the visible members in order, whether it is the one shown, and a dispute form', () => {
    const lost = renderToStaticMarkup(<ClusterList items={[cluster()]} dispute="/x" {...shared('en')} />);
    expect(lost).toContain('Your clients see the first listing of the group instead');
    expect(lost.indexOf('Their villa')).toBeLessThan(lost.indexOf('Our villa'));
    expect(lost).toContain('value="CANONICAL"');
    expect(lost).toContain(`name="listingId" value="${uuid(2)}"`);
    // the canonical one cannot ask to be canonical
    const shown = renderToStaticMarkup(
      <ClusterList items={[cluster({ canonical: true })]} dispute="/x" {...shared('es')} />,
    );
    expect(shown).toContain('Tus clientes ven este anuncio');
    expect(shown).not.toContain('value="CANONICAL"');
    const open = renderToStaticMarkup(
      <ClusterList
        items={[cluster({ openDispute: { id: uuid(9), kind: 'NOT_DUPLICATE' } })]}
        dispute="/x"
        {...shared('en')}
      />,
    );
    expect(open).toContain('Dispute open: It is not the same property');
    expect(open).not.toContain('<form');
  });

  it('[R2-03b] URL and form state: known values only', () => {
    expect(parseDuplicatesState({ view: 'clusters', status: 'CONFIRMED', cursor: 'ab_1' })).toEqual({
      view: 'clusters',
      status: 'CONFIRMED',
      cursor: 'ab_1',
    });
    expect(parseDuplicatesState({ view: 'x', status: 'NOPE', cursor: 'a b' })).toEqual({
      view: 'reviews',
      status: 'PENDING',
    });
    expect(viewQuery({ view: 'reviews', status: 'NOT_DUPLICATE' })).toEqual({ status: 'NOT_DUPLICATE' });
    const f = new FormData();
    f.set('id', uuid(1));
    f.set('move', 'not-duplicate');
    f.set('back.status', 'CONFIRMED');
    expect(parseDecision(f)).toEqual({ id: uuid(1), move: 'not-duplicate' });
    expect(backQuery(f)).toEqual({ status: 'CONFIRMED' });
    f.set('move', 'merge');
    expect(parseDecision(f)).toBeNull();
    const d = new FormData();
    d.set('listingId', uuid(2));
    d.set('kind', 'CANONICAL');
    d.set('reason', '  We hold the mandate  ');
    expect(parseDispute(d)).toEqual({ listingId: uuid(2), kind: 'CANONICAL', reason: 'We hold the mandate' });
    d.set('reason', '   ');
    expect(parseDispute(d)).toBeNull();
    expect(doneOf('disputed')).toBe('disputed');
    expect(doneOf('<b>')).toBeNull();
  });
});
