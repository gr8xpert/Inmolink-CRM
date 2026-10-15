import { describe, expect, it } from 'vitest';
import { CreateLocationInput, UpdateCatalogItemInput, UpdateLocationInput } from './taxonomy';

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
});
