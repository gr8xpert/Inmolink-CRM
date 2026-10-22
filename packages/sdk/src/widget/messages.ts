import en from '@inmolink/i18n/messages/en/widget.json' with { type: 'json' };
import es from '@inmolink/i18n/messages/es/widget.json' with { type: 'json' };

/**
 * The widget's UI strings (S8-06): the `widget` catalog of `packages/i18n` (EN and ES, checked by `pnpm i18n:check`),
 * bundled into the script — a browser widget cannot load catalogs at runtime. Messages are ICU subset: `{name}`
 * placeholders and `{count, plural, one {…} other {…}}` (with `#`), read with `Intl.PluralRules`. A test pins the
 * bundled languages to `locales.json` `ui.locales`.
 */
export type MessageKey = keyof typeof en;
export type WidgetLang = 'en' | 'es';
export const WIDGET_LANGS: readonly WidgetLang[] = ['en', 'es'];

const CATALOGS: Record<WidgetLang, Record<MessageKey, string>> = { en, es };

/** `es`, `es-ES` … → `es`; anything else → `en`. */
export function pickLang(requested: string | null | undefined): WidgetLang {
  const base = requested?.toLowerCase().split('-')[0];
  return WIDGET_LANGS.find((l) => l === base) ?? 'en';
}

const PLURAL = /\{(\w+), plural, ((?:=?\w+ \{[^{}]*\} ?)+)\}/g;

export function translate(lang: WidgetLang, key: MessageKey, vars: Record<string, string | number> = {}): string {
  return CATALOGS[lang][key]
    .replace(PLURAL, (_, name: string, forms: string) => {
      const n = Number(vars[name]);
      const table = new Map([...forms.matchAll(/(=?\w+) \{([^{}]*)\}/g)].map((m) => [m[1], m[2]] as const));
      const form = table.get(`=${n}`) ?? table.get(new Intl.PluralRules(lang).select(n)) ?? table.get('other') ?? '';
      return form.replace(/#/g, String(n));
    })
    .replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}
