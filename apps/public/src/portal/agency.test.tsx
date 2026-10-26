import type { PortalAgencyProfile, PortalCard } from '@inmolink/core/modules/website-api';
import { translator } from '@inmolink/i18n/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { agencyJsonLd, serializeJsonLd } from './seo';
import { AgencyProfileIntro, initialsOf, profileSummary } from './ui/agency-profile';
import { ResultList } from './ui/results';
import { languageName } from './ui/shell';

// Server components translate on the server: the same catalogs, without a request.
vi.mock('next-intl/server', () => ({
  getTranslations: async ({ locale, namespace }: { locale: string; namespace: 'portal' }) =>
    translator(locale, namespace),
}));

const ID = '01900000-0000-7000-8000-0000000000a1';
const PATH = `/en/agency/${ID}/move-homes`;
const settings = { origin: 'https://inmolink.test', map: null, turnstileSiteKey: 'turnstile-site-key' };

function profile(over: Partial<PortalAgencyProfile> = {}): PortalAgencyProfile {
  return {
    id: ID,
    name: 'Move Homes',
    email: 'hola@move.example',
    phone: '+34 600 000 000',
    website: 'https://move.example',
    kind: 'AGENCY',
    registerNumber: 'AICAT-4711',
    languages: ['es', 'en'],
    city: 'Rojales',
    tagline: 'Homes by the sea',
    description: 'We sell homes on the coast.\n\nSince 1998.',
    textLocale: 'en',
    paths: { en: PATH, es: `/es/agency/${ID}/move-homes` },
    ...over,
  };
}

const render = async (p: PortalAgencyProfile, locale = 'en', full = true) =>
  renderToStaticMarkup(await AgencyProfileIntro({ locale, agency: p, path: p.paths[locale] ?? PATH, settings, full }));

describe('agency profile page (S15-03)', () => {
  it('[S15-03] shows what the agency published: kind and town, texts, register number, languages, contacts', async () => {
    const html = await render(profile());
    expect(html).toContain('Estate agency in Rojales');
    expect(html).toContain('Verified business on Inmolink');
    expect(html).toContain('Homes by the sea');
    expect(html).toContain('<p>We sell homes on the coast.</p><p>Since 1998.</p>');
    expect(html).toContain('AICAT-4711');
    expect(html).toContain('Spanish, English');
    expect(html).toContain('href="tel:+34600000000"');
    expect(html).toContain('href="mailto:hola@move.example?subject=Enquiry%20from%20Inmolink"');
    expect(html).toContain('href="https://move.example/"');
    expect(html).toContain('rel="nofollow noopener noreferrer"');
    // The contact form names the agency (a general enquiry), and comes back to this page.
    expect(html).toContain(`name="agency" value="${ID}"`);
    expect(html).not.toContain('name="code"');
    expect(html).toContain(`name="back" value="${PATH}"`);
    // Spanish page: Spanish labels; a text the agency wrote only in English is marked as English.
    const es = await render(profile(), 'es');
    expect(es).toContain('Agencia inmobiliaria en Rojales');
    expect(es).toContain('Español, Inglés');
    expect(es).toContain('lang="en"');
    // Numbered pages: the line under the name only.
    expect(await render(profile(), 'en', false)).toBe(
      '<p class="mt-3 text-base text-stone">Estate agency in Rojales</p>',
    );
  });

  it('[S15-03] white-label safe: only http(s) websites and plain addresses become links; text is never markup', async () => {
    const html = await render(
      profile({
        website: 'javascript:alert(1)',
        email: 'x@y.example?bcc=all@victim.example',
        description: '<script>alert(1)</script><img src=x onerror=alert(1)>',
        registerNumber: null,
        languages: [],
        city: null,
        kind: 'DEVELOPER',
      }),
    );
    expect(html).not.toMatch(/javascript:|mailto:|<script>|<img/i);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Property developer');
    expect(html).not.toContain('Agent register number');
    expect(html).not.toContain('Languages spoken');
  });

  it('[S15-03] JSON-LD RealEstateAgent: its page as @id, only published facts; safe to inline', () => {
    const ld = agencyJsonLd({
      url: `https://inmolink.test${PATH}`,
      name: 'Move </script> Homes',
      description: 'Homes by the sea',
      email: 'hola@move.example',
      telephone: '+34 600 000 000',
      website: 'https://move.example/',
      city: 'Rojales',
      languages: ['es', 'en'],
      registerNumber: 'AICAT-4711',
    });
    expect(ld).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'RealEstateAgent',
      '@id': `https://inmolink.test${PATH}`,
      url: `https://inmolink.test${PATH}`,
      sameAs: ['https://move.example/'],
      address: { '@type': 'PostalAddress', addressLocality: 'Rojales' },
      knowsLanguage: ['es', 'en'],
      identifier: { '@type': 'PropertyValue', value: 'AICAT-4711' },
    });
    expect(serializeJsonLd(ld)).not.toContain('</script>');
    const bare = agencyJsonLd({
      url: 'https://inmolink.test/x',
      name: 'X',
      description: null,
      email: null,
      telephone: null,
      website: null,
      city: null,
      languages: [],
      registerNumber: null,
    });
    expect(Object.keys(bare).sort()).toEqual(['@context', '@id', '@type', 'name', 'url']);
  });

  it('[S15-03] search cards link the listing agency’s profile page', async () => {
    const item = {
      card: {
        id: '01900000-0000-7000-8000-0000000000b1',
        propertyType: { id: 't', name: 'Villa' },
        place: { country: null, region: null, city: { id: 'c', name: 'Rojales' }, area: null },
        price: { amountCents: 25_000_000, currency: 'EUR', onRequest: false },
        bedrooms: 3,
        bathrooms: 2,
        builtM2: 120,
        plotM2: null,
        cover: null,
        imageCount: 0,
        geo: null,
      },
      code: 'AB12CD34',
      excerpt: null,
      terraceM2: null,
      agency: { id: ID, name: 'Move Homes', email: null, phone: null, website: null },
    } as unknown as PortalCard;
    const html = renderToStaticMarkup(await ResultList({ locale: 'en', items: [item] }));
    expect(html).toContain(`href="${PATH}"`);
    expect(html).toContain('href="/en/property/villa-in-rojales-ab12cd34"');
  });

  it('[S15-03] helpers: initials for the mark, language names in the page’s language', () => {
    expect(initialsOf('Costa Homes S.L.')).toBe('CH');
    // The meta description: one sentence stop between tagline and about text, never two.
    expect(profileSummary({ tagline: 'Homes by the sea', description: 'We sell.' })).toBe('Homes by the sea. We sell.');
    expect(profileSummary({ tagline: 'Homes by the sea.', description: 'We sell.' })).toBe(
      'Homes by the sea. We sell.',
    );
    expect(profileSummary({ tagline: 'Homes!', description: null })).toBe('Homes!');
    expect(profileSummary({ tagline: null, description: ' Line one\n\nline two ' })).toBe('Line one line two');
    expect(profileSummary({ tagline: '  ', description: null })).toBeNull();
    expect(initialsOf('Ñandú')).toBe('Ñ');
    expect(languageName('en', 'de')).toBe('German');
    expect(languageName('es', 'de')).toBe('Alemán');
  });
});
