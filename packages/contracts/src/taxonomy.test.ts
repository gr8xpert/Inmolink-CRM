import { describe, expect, it } from 'vitest';
import {
  CreateLocationInput,
  GeoMultiPolygon,
  ReorderLocationsInput,
  UpdateCatalogItemInput,
  UpdateLocationInput,
} from './taxonomy';

describe('taxonomy contracts', () => {
  it('[S2-F4] a translation set names each locale once', () => {
    const en = { locale: 'en', name: 'Marbella', slug: 'marbella' };
    const es = { locale: 'es', name: 'Marbella', slug: 'marbella' };
    const create = { parentId: null, level: 'COUNTRY', translations: [en, es] };
    expect(CreateLocationInput.safeParse(create).success).toBe(true);
    expect(CreateLocationInput.safeParse({ ...create, translations: [en, { ...en, name: 'Other' }] }).success).toBe(
      false,
    );
    expect(UpdateLocationInput.safeParse({ translations: [es, es] }).success).toBe(false);
    expect(UpdateCatalogItemInput.safeParse({ kind: 'feature', scope: 'item', translations: [en, en] }).success).toBe(
      false,
    );
  });

  it('[S3-F1] polygons are capped at 50 polygons, 50 rings and 10,000 vertices', () => {
    const ring = (n: number) => [...Array.from({ length: n - 1 }, (_, i) => [i / n, (i * i) / (n * n)]), [0, 0]];
    const mp = (coordinates: unknown) => GeoMultiPolygon.safeParse({ type: 'MultiPolygon', coordinates }).success;
    expect(mp([[ring(5)]])).toBe(true);
    expect(mp(Array.from({ length: 51 }, () => [ring(5)]))).toBe(false);
    expect(mp([Array.from({ length: 51 }, () => ring(5))])).toBe(false);
    expect(mp([[ring(10_000)]])).toBe(true);
    expect(mp([[ring(5_001)], [ring(5_000)]])).toBe(false);
  });

  it('[S3-F1] a reorder covers the largest sibling set (> 2,248 cities in one region)', () => {
    const ids = Array.from({ length: 2_500 }, (_, i) => `0190a000-0000-7000-8000-${String(i).padStart(12, '0')}`);
    expect(ReorderLocationsInput.safeParse({ parentId: null, orderedIds: ids }).success).toBe(true);
  });
});
