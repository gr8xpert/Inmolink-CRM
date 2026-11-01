import { LEGAL_DOCS, SUB_PROCESSORS } from '@inmolink/contracts';
import { loadMessages } from '@inmolink/i18n/server';
import { describe, expect, it } from 'vitest';
import { LEGAL_NAV_KEYS, LEGAL_SECTIONS } from '../../app/[locale]/legal/docs';
import { allowsOptional, CONSENT_COOKIE, clearConsentCookie, consentCookie, readConsent } from './cookie-consent';

/** S16-04: the cookie choice and the legal pages' structure (texts are placeholders until H7). */
describe('cookie consent', () => {
  it('[S16-04] no choice means ask; optional cookies only after "accept all"; a stale version asks again', () => {
    expect(readConsent(undefined)).toBeNull();
    expect(readConsent('a=1; b=2')).toBeNull();
    expect(readConsent(`a=1; ${CONSENT_COOKIE}=v1.essential`)).toBe('essential');
    expect(readConsent(`${CONSENT_COOKIE}=v1.all; z=9`)).toBe('all');
    expect(readConsent(`${CONSENT_COOKIE}=v0.all`)).toBeNull();
    expect(readConsent(`${CONSENT_COOKIE}=yes`)).toBeNull();
    expect(allowsOptional(null)).toBe(false);
    expect(allowsOptional('essential')).toBe(false);
    expect(allowsOptional('all')).toBe(true);
    const cookie = consentCookie('essential', true);
    expect(cookie).toMatch(/^inl_consent=v1\.essential; Path=\/; Max-Age=31536000; SameSite=Lax; Secure$/);
    expect(readConsent(cookie.split(';')[0])).toBe('essential');
    expect(consentCookie('all', false)).not.toContain('Secure');
    // "Cookie settings" forgets the choice: the banner asks again
    expect(clearConsentCookie(true)).toBe('inl_consent=; Path=/; Max-Age=0; SameSite=Lax; Secure');
    expect(readConsent(clearConsentCookie(false).split(';')[0])).toBeNull();
  });
});

describe('legal pages', () => {
  it('[S16-04] privacy, cookie, terms and sub-processor pages have every text in EN and ES, marked as a draft', () => {
    for (const locale of ['en', 'es'] as const) {
      const legal = loadMessages(locale).legal as unknown as Record<string, unknown> & {
        nav: Record<string, string>;
        draftNotice: string;
        subProcessors: { purposes: Record<string, string> };
      };
      expect(legal.draftNotice).toContain('{version}');
      expect((legal.consent as unknown as Record<string, string>).settings).toBeTruthy();
      for (const doc of LEGAL_DOCS) expect(legal.nav[LEGAL_NAV_KEYS[doc]]).toBeTruthy();
      for (const [doc, keys] of Object.entries(LEGAL_SECTIONS)) {
        const sections = (legal[doc] as { sections: Record<string, { title: string; body: string }> }).sections;
        expect(Object.keys(sections).sort()).toEqual([...keys].sort());
        for (const k of keys) expect(sections[k]?.title && sections[k]?.body).toBeTruthy();
      }
      for (const s of SUB_PROCESSORS) for (const p of s.purposes) expect(legal.subProcessors.purposes[p]).toBeTruthy();
    }
    // the placeholders that wait on the lawyer say so
    expect(JSON.stringify(loadMessages('en').legal)).toContain('H7');
  });

  it('[S16-F5] sub-processor names and locations translated', () => {
    for (const locale of ['en', 'es'] as const) {
      const vendors = (
        loadMessages(locale).legal as unknown as {
          subProcessors: { vendors: Record<string, { name: string; location: string }> };
        }
      ).subProcessors.vendors;
      expect(Object.keys(vendors).sort()).toEqual(SUB_PROCESSORS.map((s) => s.key).sort());
      for (const s of SUB_PROCESSORS) {
        expect(vendors[s.key]?.name, `${locale} ${s.key} name`).toBeTruthy();
        expect(vendors[s.key]?.location, `${locale} ${s.key} location`).toBeTruthy();
      }
    }
    // the ES list is translated, not a copy of the EN one
    const en = loadMessages('en').legal as unknown as {
      subProcessors: { vendors: Record<string, { location: string }> };
    };
    const es = loadMessages('es').legal as unknown as {
      subProcessors: { vendors: Record<string, { location: string }> };
    };
    expect(es.subProcessors.vendors.stripe?.location).not.toBe(en.subProcessors.vendors.stripe?.location);
  });
});
