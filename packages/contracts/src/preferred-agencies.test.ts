import { describe, expect, it } from 'vitest';
import { AddPreferredAgencyBody, DirectorySearchQuery, UpdatePreferredAgencyBody } from './preferred-agencies';

const ID = '01920000-0000-7000-8000-000000000001';

describe('preferred agencies contracts (S1-07)', () => {
  it('[S1-07] notes are trimmed, empty means none, and bounded', () => {
    expect(AddPreferredAgencyBody.parse({ agencyId: ID, note: '  Good partner  ' }).note).toBe('Good partner');
    expect(UpdatePreferredAgencyBody.parse({ note: '   ' }).note).toBeNull();
    expect(UpdatePreferredAgencyBody.parse({ note: null }).note).toBeNull();
    expect(UpdatePreferredAgencyBody.safeParse({ note: 'x'.repeat(1001) }).success).toBe(false);
    expect(AddPreferredAgencyBody.safeParse({ agencyId: 'nope' }).success).toBe(false);
    expect(AddPreferredAgencyBody.safeParse({ agencyId: ID, extra: 1 }).success).toBe(false);
  });

  it('[S1-07] directory search needs at least three characters (no scraping by two-letter prefixes)', () => {
    expect(DirectorySearchQuery.safeParse({ q: ' ab ' }).success).toBe(false);
    expect(DirectorySearchQuery.parse({ q: ' Costa ' }).q).toBe('Costa');
    expect(DirectorySearchQuery.safeParse({ q: 'x'.repeat(81) }).success).toBe(false);
  });
});
