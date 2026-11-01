'use client';

import { useEffect, useState } from 'react';
import { COOKIE_SETTINGS_EVENT, type ConsentChoice, consentCookie, readConsent } from './cookie-consent';

export interface CookieBannerText {
  text: string;
  essentialOnly: string;
  acceptAll: string;
  policy: string;
  label: string;
}

/**
 * The cookie banner (S16-04): shown until the visitor chooses; both buttons are equally prominent (no pre-ticked or
 * nudged choice). Renders nothing on the server and until it has read the cookie, so a page never flashes it for a
 * visitor who already chose. Strings come as props (the root layout translates them).
 */
export function CookieBanner({ text, policyHref }: { text: CookieBannerText; policyHref: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(readConsent(document.cookie) === null);
    // "Cookie settings" (anywhere on the page) reopens the banner
    const reopen = () => setOpen(true);
    window.addEventListener(COOKIE_SETTINGS_EVENT, reopen);
    return () => window.removeEventListener(COOKIE_SETTINGS_EVENT, reopen);
  }, []);
  if (!open) return null;
  const choose = (choice: ConsentChoice) => {
    // biome-ignore lint/suspicious/noDocumentCookie: one first-party cookie, written once on a click
    document.cookie = consentCookie(choice, window.location.protocol === 'https:');
    setOpen(false);
  };
  return (
    <section
      aria-label={text.label}
      className="fixed inset-x-0 bottom-0 z-50 border-t bg-background p-4 text-sm shadow-lg"
    >
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-3">
        <p className="flex-1 basis-64">
          {text.text}{' '}
          <a href={policyHref} className="underline">
            {text.policy}
          </a>
        </p>
        <button type="button" onClick={() => choose('essential')} className="h-9 rounded-md border px-3 font-medium">
          {text.essentialOnly}
        </button>
        <button type="button" onClick={() => choose('all')} className="h-9 rounded-md border px-3 font-medium">
          {text.acceptAll}
        </button>
      </div>
    </section>
  );
}
