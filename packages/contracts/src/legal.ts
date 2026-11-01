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
/** Stable key of a sub-processor (its name and location: `legal.subProcessors.vendors.<key>.name / location`). */
export type SubProcessorKey = 'euHosting' | 'cloudflare' | 'stripe' | 'email' | 'anthropic' | 'sentry';

export interface SubProcessor {
  /** Stable key (i18n, tests). S16-F5: the company's name and where it processes data are translated by this key. */
  key: SubProcessorKey;
  purposes: readonly SubProcessorPurpose[];
  /** False while the vendor, its region or its DPA is not confirmed (H3 accounts, H4 servers, H7 review). */
  confirmed: boolean;
}

/**
 * Sub-processors of personal data (PLAN §13: Cloudflare, Stripe, e-mail and AI providers; EU-only hosting). Draft:
 * vendors and regions follow the accounts the platform opens (H3) and the servers it rents (H4); the lawyer confirms
 * the list and the transfer basis of each (H7) before R1. Names and locations: `packages/i18n` (`legal.subProcessors.vendors`).
 */
export const SUB_PROCESSORS: readonly SubProcessor[] = [
  { key: 'euHosting', purposes: ['hosting'], confirmed: false },
  { key: 'cloudflare', purposes: ['cdn', 'storage', 'bot'], confirmed: false },
  { key: 'stripe', purposes: ['payments'], confirmed: false },
  { key: 'email', purposes: ['email'], confirmed: false },
  { key: 'anthropic', purposes: ['ai'], confirmed: false },
  { key: 'sentry', purposes: ['errors'], confirmed: false },
];
