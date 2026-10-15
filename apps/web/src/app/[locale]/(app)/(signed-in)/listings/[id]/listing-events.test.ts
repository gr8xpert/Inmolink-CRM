import type { QualityHint } from '@inmolink/contracts';
import { describe, expect, it, vi } from 'vitest';
import { makeT } from '../values';
import { notifyListingChanged, onListingChanged } from './listing-events';
import { hintText } from './quality-hints';

const ID = '01900000-0000-7000-8000-000000000001';
const OTHER = '01900000-0000-7000-8000-000000000002';

describe('listing change events (S3-08)', () => {
  it('[S3-08] score changes after adding photos without a manual refresh: a saved change reaches the quality panel', () => {
    const page = new EventTarget();
    const refresh = vi.fn();
    const off = onListingChanged(ID, refresh, page);
    // The media manager saved photos for this listing: the panel asks for its score again.
    notifyListingChanged(ID, page);
    expect(refresh).toHaveBeenCalledTimes(1);
    // Another listing's change is not this panel's business.
    notifyListingChanged(OTHER, page);
    expect(refresh).toHaveBeenCalledTimes(1);
    off();
    notifyListingChanged(ID, page);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('[S3-08] fix-it hints read with their numbers filled in', () => {
    const t = makeT({ quality: { hints: { PHOTOS_FEW: 'Add photos: {count} of {target} recommended' } } });
    const hint: QualityHint = { code: 'PHOTOS_FEW', section: 'media', gain: 20, params: { count: 3, target: 15 } };
    expect(hintText(t, hint)).toBe('Add photos: 3 of 15 recommended');
  });
});
