'use client';

import { cn } from '@inmolink/ui';
import { type ReactNode, useEffect, useState } from 'react';
import { Link, usePathname } from '@/i18n/navigation';

export interface PrimaryNavLink {
  href: string;
  label: string;
}

/**
 * The shell's main navigation (S1-10): a sidebar from `md` up; on small screens a "Menu" toggle opens
 * the list (and a navigation closes it again). The current page carries `aria-current="page"`. Items
 * and labels come from the server; this island only tracks the path and the open state.
 *
 * S17-F38: `account` (the signed-in member's block) sits under the list on `md` and up; on small screens it is part of
 * the same menu, so a closed menu is one row instead of a 320 px block above every page.
 */
export function PrimaryNav({
  items,
  label,
  openLabel,
  closeLabel,
  account,
}: {
  items: PrimaryNavLink[];
  label: string;
  openLabel: string;
  closeLabel: string;
  account?: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: close the menu whenever the page changes
  useEffect(() => setOpen(false), [pathname]);
  const current = (href: string) =>
    href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="flex flex-col md:flex-1">
      <nav aria-label={label} className="border-b md:border-b-0">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium md:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          aria-expanded={open}
          aria-controls={account ? 'primary-nav-list primary-nav-account' : 'primary-nav-list'}
          onClick={() => setOpen((v) => !v)}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="size-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
          {open ? closeLabel : openLabel}
        </button>
        <ul id="primary-nav-list" className={cn('flex-col gap-1 p-3 md:flex', open ? 'flex' : 'hidden')}>
          {items.map((item) => {
            const active = current(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  // S13-04: product tours point at nav items by their path
                  data-tour-target={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'block rounded-md px-3 py-2 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active && 'bg-accent text-accent-foreground',
                  )}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      {account ? (
        <div id="primary-nav-account" className={cn('md:mt-auto md:block', open ? 'block' : 'hidden')}>
          {account}
        </div>
      ) : null}
    </div>
  );
}
