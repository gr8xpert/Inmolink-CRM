import raw from '../locales.json' with { type: 'json' };

/**
 * Locale configuration (PLAN §3 #14), read from `packages/i18n/locales.json` — adding a locale is a
 * config change, never a code change. UI locales (dashboard and portal chrome, emails) and content
 * locales (listing descriptions, slugs, websites) are separate lists.
 */
export interface LocaleConfig {
  ui: {
    default: string;
    locales: string[];
    /** Written by hand for every key (EN and ES); the others are drafted by `pnpm i18n:draft`. */
    handwritten: string[];
  };
  /**
   * `fallback`: the translation shown when a record has none in the wanted locale (taxonomy names and
   * slugs); defaults to `default`.
   */
  content: { default: string; fallback: string; locales: string[] };
  /** IANA zone for date formatting when the user has none. */
  timeZone: string;
}

const LOCALE_CODE = /^[a-z]{2,3}(-[A-Z]{2})?$/;

export class LocaleConfigError extends Error {}

/** Validates a locale config; throws `LocaleConfigError` naming the first problem. */
export function parseLocaleConfig(input: unknown): LocaleConfig {
  const c = input as Partial<LocaleConfig> | null;
  const fail = (message: string): never => {
    throw new LocaleConfigError(`locales.json: ${message}`);
  };
  const list = (value: unknown, name: string): string[] => {
    if (!Array.isArray(value) || value.length === 0) fail(`${name} must be a non-empty array`);
    const codes = value as unknown[];
    for (const code of codes) {
      if (typeof code !== 'string' || !LOCALE_CODE.test(code))
        fail(`${name} has an invalid locale code: ${String(code)}`);
    }
    if (new Set(codes).size !== codes.length) fail(`${name} has duplicates`);
    return codes as string[];
  };
  const ui = list(c?.ui?.locales, 'ui.locales');
  const handwritten = list(c?.ui?.handwritten, 'ui.handwritten');
  const content = list(c?.content?.locales, 'content.locales');
  const uiDefault = c?.ui?.default ?? '';
  const contentDefault = c?.content?.default ?? '';
  if (!ui.includes(uiDefault)) fail('ui.default must be one of ui.locales');
  if (!handwritten.includes(uiDefault)) fail('ui.default must be handwritten');
  if (handwritten.some((l) => !ui.includes(l))) fail('ui.handwritten must be a subset of ui.locales');
  if (!content.includes(contentDefault)) fail('content.default must be one of content.locales');
  const contentFallback = c?.content?.fallback ?? contentDefault;
  if (!content.includes(contentFallback)) fail('content.fallback must be one of content.locales');
  const timeZone = c?.timeZone ?? '';
  try {
    new Intl.DateTimeFormat('en', { timeZone });
  } catch {
    fail(`timeZone is not a valid IANA zone: ${timeZone}`);
  }
  return {
    ui: { default: uiDefault, locales: ui, handwritten },
    content: { default: contentDefault, fallback: contentFallback, locales: content },
    timeZone,
  };
}

export const localeConfig: LocaleConfig = parseLocaleConfig(raw);

/** A UI locale code from `locales.json` (`en`, `es`, …). */
export type UiLocale = string;
/** A content locale code from `locales.json`. */
export type ContentLocale = string;

export const UI_LOCALES: readonly UiLocale[] = localeConfig.ui.locales;
export const DEFAULT_UI_LOCALE: UiLocale = localeConfig.ui.default;
export const HANDWRITTEN_UI_LOCALES: readonly UiLocale[] = localeConfig.ui.handwritten;
export const CONTENT_LOCALES: readonly ContentLocale[] = localeConfig.content.locales;
export const DEFAULT_CONTENT_LOCALE: ContentLocale = localeConfig.content.default;
/** The translation used when a record has none in the wanted locale (then any other). */
export const FALLBACK_CONTENT_LOCALE: ContentLocale = localeConfig.content.fallback;
export const DEFAULT_TIME_ZONE: string = localeConfig.timeZone;

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === 'string' && UI_LOCALES.includes(value);
}

export function isContentLocale(value: unknown): value is ContentLocale {
  return typeof value === 'string' && CONTENT_LOCALES.includes(value);
}

/** Best UI locale for an `Accept-Language` header (q-values honoured, region ignored). */
export function negotiateLocale(
  acceptLanguage: string | null | undefined,
  locales: readonly string[] = UI_LOCALES,
  fallback: string = DEFAULT_UI_LOCALE,
): UiLocale {
  if (!acceptLanguage) return fallback;
  const ranked = acceptLanguage
    .split(',')
    .slice(0, 20)
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = Number(
        params
          .find((p) => p.trim().startsWith('q='))
          ?.trim()
          .slice(2) ?? '1',
      );
      const [lang = '', region] = tag.trim().split('-');
      const full = region ? `${lang.toLowerCase()}-${region.toUpperCase()}` : lang.toLowerCase();
      return { full, lang: lang.toLowerCase(), q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((r) => r.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  // Exact tag first (`pt-BR`), then the bare language (`es-ES` → `es`).
  for (const r of ranked) {
    if (locales.includes(r.full)) return r.full;
    if (locales.includes(r.lang)) return r.lang;
  }
  return fallback;
}
