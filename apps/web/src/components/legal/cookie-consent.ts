/**
 * Cookie consent (S16-04, ePrivacy / LSSI art. 22.2): the visitor's choice, kept in a first-party cookie for 12 months.
 * Strictly necessary cookies (session, CSRF, bot protection) need no consent and are always set; anything optional
 * (analytics, marketing — none today) must check `allowsOptional` first. Pure helpers: the banner and tests use them.
 */

export const CONSENT_COOKIE = 'inl_consent';
/** 12 months (seconds). */
export const CONSENT_MAX_AGE = 365 * 24 * 3_600;
/** Bumped when the cookie policy changes what is asked: an older choice is asked again. */
export const CONSENT_VERSION = 1;

export type ConsentChoice = 'essential' | 'all';

/** The stored choice (`v1.essential` / `v1.all`) from a `Cookie` header or `document.cookie`; null: ask. */
export function readConsent(cookieHeader: string | null | undefined): ConsentChoice | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== CONSENT_COOKIE) continue;
    const m = /^v(\d+)\.(essential|all)$/.exec(rest.join('='));
    if (!m || Number(m[1]) !== CONSENT_VERSION) return null;
    return m[2] as ConsentChoice;
  }
  return null;
}

/** The stored value of a choice (`v1.essential`): what `readConsent` accepts. */
export function consentValue(choice: ConsentChoice): string {
  return `v${CONSENT_VERSION}.${choice}`;
}

/** The `document.cookie` assignment that records a choice (site-wide, Lax, Secure on https). */
export function consentCookie(choice: ConsentChoice, secure: boolean): string {
  return `${CONSENT_COOKIE}=${consentValue(choice)}; Path=/; Max-Age=${CONSENT_MAX_AGE}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** The `document.cookie` assignment that forgets the choice (the banner asks again). */
export function clearConsentCookie(secure: boolean): string {
  return `${CONSENT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** Dispatched on `window` by "Cookie settings": the banner opens again. */
export const COOKIE_SETTINGS_EVENT = 'inl:cookie-settings';

/** Whether optional cookies (analytics, marketing) may be set. */
export const allowsOptional = (choice: ConsentChoice | null) => choice === 'all';
