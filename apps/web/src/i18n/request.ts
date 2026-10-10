import { DEFAULT_TIME_ZONE } from '@inmolink/i18n';
import { loadMessages } from '@inmolink/i18n/server';
import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import { routing } from './routing';

/** Per-request next-intl config: the route locale and its catalogs (EN under drafted locales). */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  return { locale, messages: loadMessages(locale), timeZone: DEFAULT_TIME_ZONE };
});
