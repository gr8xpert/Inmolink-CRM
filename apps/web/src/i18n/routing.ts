import { DEFAULT_UI_LOCALE, UI_LOCALES } from '@inmolink/i18n';
import { defineRouting } from 'next-intl/routing';

/**
 * Locale-prefixed routes (`/es/login`), locales from `packages/i18n/locales.json` (S0-11). A request
 * without a prefix is redirected to the best locale: the `NEXT_LOCALE` cookie, then Accept-Language.
 */
export const routing = defineRouting({
  locales: [...UI_LOCALES],
  defaultLocale: DEFAULT_UI_LOCALE,
  localePrefix: 'always',
  // No hreflang `Link` header: the dashboard is not indexed, and it would echo one-time link tokens.
  alternateLinks: false,
});
