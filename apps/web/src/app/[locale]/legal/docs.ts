import type { LegalDoc } from '@inmolink/contracts';

/** i18n keys of each legal document (`legal.nav.<key>`, `legal.<key>.*`). */
export const LEGAL_NAV_KEYS = {
  privacy: 'privacy',
  cookies: 'cookies',
  terms: 'terms',
  'sub-processors': 'subProcessors',
} as const satisfies Record<LegalDoc, string>;

/** The sections of each prose document, in order (`legal.<doc>.sections.<key>.title / body`). */
export const LEGAL_SECTIONS = {
  privacy: ['controller', 'data', 'purposes', 'retention', 'rights', 'transfers', 'contact'],
  cookies: ['essential', 'optional', 'choices'],
  terms: ['service', 'accounts', 'data', 'liability', 'law'],
} as const;
