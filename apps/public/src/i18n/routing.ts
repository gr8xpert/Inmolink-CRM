import { DEFAULT_UI_LOCALE, UI_LOCALES } from '@inmolink/i18n';
import { defineRouting } from 'next-intl/routing';

/**
 * Locale-prefixed routes (`/es/login`), locales from `packages/i18n/locales.json` (S0-11). A request
 * without a prefix is redirected to the best locale by Accept-Language (no locale cookie, S15-01).
 */
export const routing = defineRouting({
  locales: [...UI_LOCALES],
  defaultLocale: DEFAULT_UI_LOCALE,
  localePrefix: 'always',
  // S15-01 review: no NEXT_LOCALE cookie — portal pages are `public, s-maxage` (a Set-Cookie must never ride on a
  // shared cache's copy); the prefix carries the locale, Accept-Language picks it for an unprefixed URL.
  localeCookie: false,
});
