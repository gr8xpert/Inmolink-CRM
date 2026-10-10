import { createTranslator } from 'use-intl/core';
import { CATALOGS } from './catalogs.generated';
import { DEFAULT_UI_LOCALE } from './locales';
import type { Messages, Namespace } from './messages';

/**
 * Server-side catalog access. Catalogs live in `messages/<locale>/<namespace>.json` and are bundled
 * through `catalogs.generated.ts` (written by `pnpm i18n:draft`), so they work in any bundler without
 * runtime file access. A locale's messages are laid over the default locale's: a key missing in a
 * drafted locale shows the EN text, never a raw key.
 */
export type MessageTree = { [key: string]: string | MessageTree };
/** One locale's catalog, keyed by namespace. */
export type Catalog = Record<string, MessageTree>;
/** Catalogs by locale. */
export type Catalogs = Record<string, Catalog>;

function deepMerge(base: MessageTree, over: MessageTree): MessageTree {
  const out: MessageTree = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const b = out[k];
    out[k] = typeof v === 'object' && typeof b === 'object' ? deepMerge(b, v) : v;
  }
  return out;
}

const merged = new Map<string, Messages>();

/** All namespaces for `locale`, over the default locale. `catalogs` is for tests and tooling. */
export function loadMessages(locale: string, options: { catalogs?: Catalogs; fallback?: string } = {}): Messages {
  const catalogs = options.catalogs ?? (CATALOGS as Catalogs);
  const fallback = options.fallback ?? DEFAULT_UI_LOCALE;
  const cacheable = !options.catalogs;
  const hit = cacheable ? merged.get(`${fallback}|${locale}`) : undefined;
  if (hit) return hit;
  const base = catalogs[fallback] ?? {};
  const own = locale === fallback ? base : (deepMerge(base, catalogs[locale] ?? {}) as Catalog);
  const messages = own as unknown as Messages;
  if (cacheable) merged.set(`${fallback}|${locale}`, messages);
  return messages;
}

export type Translate = (key: string, values?: Record<string, string | number | Date>) => string;

/**
 * ICU translator for code outside React (emails, PDFs, jobs): `t('signup.passwordHint', { min: 10 })`.
 * Unknown keys return `namespace.key` instead of throwing.
 */
export function translator(locale: string, namespace: Namespace, options: { catalogs?: Catalogs } = {}): Translate {
  const t = createTranslator({
    locale,
    messages: loadMessages(locale, options) as unknown as Record<string, MessageTree>,
    namespace,
    onError: () => {},
    getMessageFallback: ({ namespace: ns, key }) => (ns ? `${ns}.${key}` : key),
  }) as unknown as Translate;
  return (key, values) => t(key, values);
}
