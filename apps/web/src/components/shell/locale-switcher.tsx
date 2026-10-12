'use client';

import { cn } from '@inmolink/ui';
import { Link, usePathname } from '@/i18n/navigation';

export interface LocaleOption {
  code: string;
  /** The language's own name ("Español"), so a reader finds theirs whatever the page language. */
  name: string;
}

/**
 * Language links for the current page (S1-10): plain links, so they work with the keyboard and without
 * script; the locale prefix decides the language and the proxy remembers it in `NEXT_LOCALE` (S0-11).
 */
export function LocaleSwitcher({
  label,
  locales,
  current,
}: {
  label: string;
  locales: LocaleOption[];
  current: string;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label={label}>
      <ul className="flex items-center gap-1 text-sm">
        {locales.map((l) => (
          <li key={l.code}>
            <Link
              href={pathname}
              locale={l.code}
              lang={l.code}
              hrefLang={l.code}
              aria-current={l.code === current ? 'true' : undefined}
              className={cn(
                'rounded-md px-2 py-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                l.code === current && 'font-semibold underline underline-offset-4',
              )}
            >
              {l.name}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
