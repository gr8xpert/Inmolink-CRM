import { LEGAL_DOCS } from '@inmolink/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LegalLinks, legalHref } from './ui/legal-links';

const NAMES = {
  privacy: 'Privacy notice',
  cookies: 'Cookie policy',
  terms: 'Terms of service',
  'sub-processors': 'Sub-processors',
} as const;

describe('portal footer legal links', () => {
  it('[S16-F5] the portal footer links every legal page on the dashboard, in the page locale', () => {
    const html = renderToStaticMarkup(
      <LegalLinks base="https://app.inmolink.test" locale="es" label="Información legal" names={NAMES} />,
    );
    expect(html).toContain('aria-label="Información legal"');
    for (const doc of LEGAL_DOCS) {
      expect(html).toContain(`href="https://app.inmolink.test/es/legal/${doc}"`);
      expect(html).toContain(`>${NAMES[doc]}</a>`);
    }
    expect(html).not.toContain('<script');
    expect(legalHref('https://app.inmolink.test', 'en', 'privacy')).toBe('https://app.inmolink.test/en/legal/privacy');
  });

  it('[S16-F5] without the dashboard origin (WEB_URL unset) the footer shows no legal links', () => {
    expect(renderToStaticMarkup(<LegalLinks base={null} locale="en" label="Legal" names={NAMES} />)).toBe('');
  });
});
