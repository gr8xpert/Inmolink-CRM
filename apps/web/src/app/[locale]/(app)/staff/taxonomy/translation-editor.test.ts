import { describe, expect, it } from 'vitest';
import { slugify } from './translation-editor';

describe('taxonomy translation editor', () => {
  it('[S2-04] suggests a URL slug the API accepts from any name', () => {
    expect(slugify('Milla de Oro')).toBe('milla-de-oro');
    expect(slugify('  Málaga / Costa del Sol  ')).toBe('malaga-costa-del-sol');
    expect(slugify('Puerto Banús (Marbella)')).toBe('puerto-banus-marbella');
    expect(slugify('Ελλάδα')).toBe('');
  });
});
