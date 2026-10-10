import enAuth from '../messages/en/auth.json' with { type: 'json' };
import esAuth from '../messages/es/auth.json' with { type: 'json' };

/**
 * @inmolink/i18n — UI message catalogs. EN and ES are written by hand for every key (PATTERNS §21).
 *
 * Interim API (S0-09): the UI locales are exactly the catalogs registered here, and `translator()`
 * does `{name}` interpolation. S0-11 adds `locales.ts` (config-driven UI + content locales), next-intl
 * wiring and `pnpm i18n:check`; callers then move to next-intl's `getTranslations`.
 */
export const PACKAGE_NAME = '@inmolink/i18n';

export const catalogs = {
  en: { auth: enAuth },
  es: { auth: esAuth },
} as const;

export type UiLocale = keyof typeof catalogs;
export type Namespace = keyof (typeof catalogs)['en'];

export const UI_LOCALES = Object.keys(catalogs) as UiLocale[];
/** First registered catalog. */
export const DEFAULT_UI_LOCALE = UI_LOCALES[0] as UiLocale;

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === 'string' && Object.hasOwn(catalogs, value);
}

/** Best UI locale for an `Accept-Language` header (q-values honoured, region ignored). */
export function negotiateLocale(acceptLanguage: string | null | undefined): UiLocale {
  if (!acceptLanguage) return DEFAULT_UI_LOCALE;
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
      return { lang: tag.toLowerCase().split('-')[0] ?? '', q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((r) => r.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  return (ranked.find((r) => isUiLocale(r.lang))?.lang as UiLocale | undefined) ?? DEFAULT_UI_LOCALE;
}

type Messages = { [key: string]: string | Messages };

function lookup(messages: Messages, key: string): string | undefined {
  let node: string | Messages | undefined = messages;
  for (const part of key.split('.')) {
    if (typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** `t('login.title')`, `t('signup.passwordHint', { min: 10 })`. Missing keys fall back to EN, then the key. */
export function translator(locale: UiLocale, namespace: Namespace): Translate {
  const own = catalogs[locale][namespace] as Messages;
  const fallback = catalogs[DEFAULT_UI_LOCALE][namespace] as Messages;
  return (key, vars) => {
    const template = lookup(own, key) ?? lookup(fallback, key) ?? key;
    return vars ? template.replace(/\{(\w+)\}/g, (m, name: string) => String(vars[name] ?? m)) : template;
  };
}
