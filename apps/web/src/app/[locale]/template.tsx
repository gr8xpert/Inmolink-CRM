import type { ReactNode } from 'react';
import { ImpersonationBanner } from './impersonation-banner';

/**
 * Per-navigation wrapper (S1-09 review): unlike the layout, a template renders again on every
 * navigation, so the impersonation banner always shows the session as it is now.
 */
export default function LocaleTemplate({ children }: { children: ReactNode }) {
  return (
    <>
      <ImpersonationBanner />
      {children}
    </>
  );
}
