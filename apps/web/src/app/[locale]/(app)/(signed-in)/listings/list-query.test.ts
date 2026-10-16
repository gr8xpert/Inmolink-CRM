import { DEFAULT_LISTING_COLUMNS } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import { bulkActionOf } from './bulk-action';
import { centsOf, columnsOf, listSearch, viewHref } from './list-query';
import { parseListState } from './list-state';

describe('listing list URL state (S3-07)', () => {
  it('[S3-07] filters, sort and columns round-trip through the URL; invalid values are dropped one by one', () => {
    const state = parseListState({
      status: 'ACTIVE',
      priceMin: '30000000',
      bedroomsMin: 'many',
      mine: 'true',
      tag: ' Golf ',
      locationId: 'not-a-uuid',
      sort: 'price_desc',
      cols: 'price,ref,nope,price',
      cursor: 'abc_DEF-1',
    });
    expect(state.filter).toEqual({ status: 'ACTIVE', priceMin: 30_000_000, mine: true, tag: 'golf' });
    expect(state.sort).toBe('price_desc');
    expect(state.columns).toEqual(['ref', 'price']);
    expect(state.cursor).toBe('abc_DEF-1');
    expect(parseListState(Object.fromEntries(new URLSearchParams(listSearch(state, state.cursor))))).toEqual(state);
    // Defaults stay out of the URL.
    expect(listSearch({ filter: {}, sort: 'newest', columns: [...DEFAULT_LISTING_COLUMNS] })).toBe('');
    expect(parseListState({ sort: 'sideways', cursor: 'bad cursor!' })).toMatchObject({
      sort: 'newest',
      cursor: undefined,
    });
  });

  it('[S3-07] a saved view is a link; prices are typed in euros', () => {
    expect(viewHref({ query: { visibility: 'PUBLIC', sort: 'updated' }, columns: ['ref', 'tags'] })).toBe(
      '/listings?visibility=PUBLIC&sort=updated&cols=ref%2Ctags',
    );
    expect(viewHref({ query: {}, columns: [...DEFAULT_LISTING_COLUMNS] })).toBe('/listings');
    expect(columnsOf(undefined)).toEqual(DEFAULT_LISTING_COLUMNS);
    expect(centsOf('350.000')).toBe(35_000_000);
    expect(centsOf('')).toBeUndefined();
    expect(centsOf('abc')).toBeUndefined();
    expect(centsOf('100,50')).toBeUndefined(); // decimals are not a thousands group
    expect(centsOf('1 250 000')).toBe(125_000_000);
  });

  it('[S3-07] the bulk bar builds only complete, valid actions', () => {
    expect(bulkActionOf('STATUS', 'SOLD')).toEqual({ type: 'STATUS', status: 'SOLD' });
    expect(bulkActionOf('STATUS', '')).toBeNull();
    expect(bulkActionOf('PRICE_CHANGE', '-3,5')).toEqual({ type: 'PRICE_CHANGE', percentBp: -350 });
    expect(bulkActionOf('PRICE_CHANGE', '0')).toBeNull();
    expect(bulkActionOf('PRICE_CHANGE', '-95')).toBeNull();
    expect(bulkActionOf('ADD_TAG', ' Sea View ')).toEqual({ type: 'ADD_TAG', tag: 'sea view' });
    expect(bulkActionOf('VISIBILITY', 'EVERYONE')).toBeNull();
  });
});
