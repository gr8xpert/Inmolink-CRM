/**
 * Legal pages (S16-04, PLAN §13): the documents the dashboard publishes and the sub-processor list. The texts live in
 * `packages/i18n` (`legal.*`); this file holds what is data, not prose.
 *
 * DRAFT until the lawyer's review (HUMAN-ACTIONS H7): `LEGAL_TEXT_VERSION` names the placeholder texts; when the
 * reviewed texts land, bump it (consent records store the version a form showed) and set `LEGAL_DRAFT` to false.
 */

/** The published legal documents (`/<locale>/legal/<doc>`). */
export const LEGAL_DOCS = ['privacy', 'cookies', 'terms', 'sub-processors'] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];

/** Version of the legal texts shown (privacy notice, terms, cookie policy). */
export const LEGAL_TEXT_VERSION = 'draft-2026-11';
/** The texts are placeholders awaiting legal review (H7): every page says so. */
export const LEGAL_DRAFT = true;

/** What a sub-processor does for Inmolink (the page translates it: `legal.subProcessors.purposes.<purpose>`). */
export type SubProcessorPurpose = 'hosting' | 'cdn' | 'storage' | 'bot' | 'payments' | 'email' | 'ai' | 'errors';

export interface SubProcessor {
  /** Stable key (i18n, tests). */
  key: string;
  /** The company's name, as it trades. */
  name: string;
  purposes: readonly SubProcessorPurpose[];
  /** Where the data is processed (`EU`, or `EU + US (SCCs)` style labels until H7 confirms them). */
  location: string;
  /** False while the vendor, its region or its DPA is not confirmed (H3 accounts, H4 servers, H7 review). */
  confirmed: boolean;
}

/**
 * Sub-processors of personal data (PLAN §13: Cloudflare, Stripe, e-mail and AI providers; EU-only hosting). Draft:
 * vendors and regions follow the accounts the platform opens (H3) and the servers it rents (H4); the lawyer confirms
 * the list and the transfer basis of each (H7) before R1.
 */
export const SUB_PROCESSORS: readonly SubProcessor[] = [
  {
    key: 'eu-hosting',
    name: 'EU data-centre provider (to be confirmed)',
    purposes: ['hosting'],
    location: 'EU',
    confirmed: false,
  },
  {
    key: 'cloudflare',
    name: 'Cloudflare',
    purposes: ['cdn', 'storage', 'bot'],
    location: 'EU (R2 EU jurisdiction); CDN global',
    confirmed: false,
  },
  { key: 'stripe', name: 'Stripe', purposes: ['payments'], location: 'EU + US (SCCs)', confirmed: false },
  {
    key: 'email',
    name: 'Transactional e-mail provider (SMTP2Go / Resend / Amazon SES, to be confirmed)',
    purposes: ['email'],
    location: 'EU',
    confirmed: false,
  },
  { key: 'anthropic', name: 'Anthropic', purposes: ['ai'], location: 'US (SCCs)', confirmed: false },
  { key: 'sentry', name: 'Sentry', purposes: ['errors'], location: 'EU', confirmed: false },
];
