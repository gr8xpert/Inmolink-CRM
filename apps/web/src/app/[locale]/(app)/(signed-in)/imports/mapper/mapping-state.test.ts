import type { MapperSampleDto } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import { initialState, toMapping } from './mapping-state';

/** S7-F2: the mapper starts from the server's guesses only (`sample.suggested`); it guesses nothing itself. */
const sample = (suggested: Record<string, string>, paths: string[] = []): MapperSampleDto => ({
  recordElement: 'item',
  candidates: [{ name: 'item', count: 2 }],
  recordCount: 2,
  truncated: false,
  bytes: 100,
  paths: paths.map((path) => ({ path, count: 2, repeated: false, samples: [] })),
  suggested,
  records: [],
});

describe('mapper initial state', () => {
  it('[S7-F2] takes fields, lists and the first translation’s title and description from sample.suggested', () => {
    const state = initialState(
      sample({
        ref: '@id',
        propertyType: 'type',
        features: 'tags/tag',
        title: 'info/titulo',
        description: 'info/desc',
      }),
      'es',
    );
    expect(state.fields.ref.source).toBe('@id');
    expect(state.fields.propertyType.source).toBe('type');
    expect(state.fields.price.source).toBe('');
    expect(state.features.path).toBe('tags/tag');
    expect(state.translations).toEqual([{ locale: 'es', title: 'info/titulo', description: 'info/desc' }]);
    expect(toMapping(state).translations).toEqual([
      { locale: 'es', title: { path: 'info/titulo' }, description: { path: 'info/desc' } },
    ]);
  });

  it('[S7-F2] a path the server did not suggest (repeated, or claimed by another field) is never picked here', () => {
    // a `title` path exists in the sample, but the server left it out of `suggested`: the web app does not guess it
    const state = initialState(sample({ ref: '@id' }, ['title', 'description', 'texts/text']), 'en');
    expect(state.translations).toEqual([{ locale: 'en', title: '', description: '' }]);
    expect(toMapping(state).translations).toEqual([]);
  });
});
