'use client';

import { COOKIE_SETTINGS_EVENT, clearConsentCookie } from './cookie-consent';

/**
 * "Cookie settings" (S16-04 review): forgets the stored choice and reopens the cookie banner, so a visitor can change
 * their mind as easily as they chose (GDPR Art. 7(3)). In the legal pages' nav and the dashboard's account section.
 */
export function CookieSettingsButton({ label, className }: { label: string; className?: string }) {
  return (
    <button
      type="button"
      className={className ?? 'underline'}
      onClick={() => {
        // biome-ignore lint/suspicious/noDocumentCookie: one first-party cookie, cleared on a click
        document.cookie = clearConsentCookie(window.location.protocol === 'https:');
        window.dispatchEvent(new Event(COOKIE_SETTINGS_EVENT));
      }}
    >
      {label}
    </button>
  );
}
