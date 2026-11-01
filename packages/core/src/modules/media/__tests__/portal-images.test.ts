import { describe, expect, it } from 'vitest';
import { portalImageKey } from '../portal-images';

describe('portal images (S15-F10)', () => {
  it('[S15-F10] a public copy is named after its upload under the portal prefix (a new upload is a new key)', () => {
    const agency = '01900000-0000-7000-8000-000000000001';
    expect(portalImageKey('agency-logos', agency, `agency-logos/${agency}/01900000-0000-7000-8000-0000000000aa`)).toBe(
      `portal/agency-logos/${agency}/01900000-0000-7000-8000-0000000000aa.webp`,
    );
    expect(portalImageKey('member-photos', agency, `member-photos/${agency}/0190-x`)).toBe(
      `portal/member-photos/${agency}/0190-x.webp`,
    );
  });
});
