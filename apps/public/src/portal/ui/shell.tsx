import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { homePath, searchPath } from '../urls';

/**
 * A language's name in `displayLocale`, capitalized, from the platform's `Intl` data: by default the locale's own name
 * in itself ("English", "Español" — the language switch); S15-03: another code in the page's language ("German" on an
 * English page, "Alemán" on a Spanish one). An unknown code is shown as is.
 */
export function languageName(displayLocale: string, code: string = displayLocale): string {
  try {
    const name = new Intl.DisplayNames([displayLocale], { type: 'language' }).of(code) ?? code;
    return name.charAt(0).toLocaleUpperCase(displayLocale) + name.slice(1);
  } catch {
    return code;
  }
}

/**
 * The portal's frame (S15-01): a slim header (wordmark, all properties, the page in the other language), the page, a
 * quiet footer. Server-rendered; plain links (no prefetch of every card, frontend rules).
 */
export async function PortalShell(props: {
  locale: string;
  /** This page in each locale (the language switch). */
  alternates: Readonly<Record<string, string>>;
  children: ReactNode;
}) {
  const t = await getTranslations({ locale: props.locale, namespace: 'portal' });
  const others = Object.entries(props.alternates).filter(([l]) => l !== props.locale);
  return (
    <div className="portal flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-10 focus:rounded focus:bg-white focus:px-3 focus:py-2"
      >
        {t('nav.skip')}
      </a>
      <header className="border-b border-shore">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <a
            href={homePath(props.locale)}
            className="text-xl font-extrabold tracking-tight text-sea-deep no-underline"
            aria-label={t('nav.home')}
          >
            inmolink
          </a>
          <nav className="ml-auto flex items-center gap-5 text-sm font-medium">
            <a href={searchPath(props.locale)} className="text-ink hover:text-sea">
              {t('nav.search')}
            </a>
            {others.length > 0 ? (
              <ul className="flex gap-3" aria-label={t('nav.language')}>
                {others.map(([l, href]) => (
                  <li key={l}>
                    <a href={href} hrefLang={l} lang={l} className="text-stone hover:text-sea">
                      {languageName(l)}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </nav>
        </div>
      </header>
      <main id="main" className="flex-1">
        {props.children}
      </main>
      <footer className="mt-16 bg-foam">
        <div className="mx-auto max-w-6xl px-4 py-8 text-sm text-stone">
          <p className="max-w-prose">{t('footer.about')}</p>
        </div>
      </footer>
    </div>
  );
}
