import { getLocale } from 'next-intl/server';
import type { ReactNode } from 'react';
import { auth } from '@/auth';
import { redirect } from '@/i18n/navigation';

/**
 * Member pages (S1-10). Signed-out visitors are sent to login here, above the `loading.tsx` boundary,
 * so the redirect is a real HTTP redirect rather than one streamed after the skeleton.
 */
export default async function SignedInLayout({ children }: { children: ReactNode }) {
  if (!(await auth())?.user?.id) return redirect({ href: '/login', locale: await getLocale() });
  return children;
}
