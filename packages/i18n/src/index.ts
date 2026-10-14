/**
 * @inmolink/i18n — locales and message catalogs (PATTERNS §21). Platform-neutral entry: locale
 * config, negotiation and formatters. Catalog loading and `translator()` are server-only
 * (`@inmolink/i18n/server`); `pnpm i18n:check` / `i18n:draft` use `@inmolink/i18n/tools`.
 */
export const PACKAGE_NAME = '@inmolink/i18n';

export { type Formatter, formatter } from './format';
export {
  CONTENT_LOCALES,
  type ContentLocale,
  DEFAULT_CONTENT_LOCALE,
  DEFAULT_TIME_ZONE,
  DEFAULT_UI_LOCALE,
  FALLBACK_CONTENT_LOCALE,
  HANDWRITTEN_UI_LOCALES,
  isContentLocale,
  isUiLocale,
  type LocaleConfig,
  LocaleConfigError,
  localeConfig,
  negotiateLocale,
  parseLocaleConfig,
  UI_LOCALES,
  type UiLocale,
} from './locales';
export type { Messages, Namespace } from './messages';
