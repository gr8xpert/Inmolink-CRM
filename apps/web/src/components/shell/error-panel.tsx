'use client';

import { Button } from '@inmolink/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import { Link } from '@/i18n/navigation';

/**
 * Error boundary content for dashboard pages (S1-10). Server errors arrive without their message
 * (Next.js keeps it on the server); the digest is the reference support finds in the logs. Focus moves
 * to the heading so keyboard and screen-reader users learn what happened. Strings: `shell.error`,
 * passed to the client by the locale layout.
 */
export function ErrorPanel({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const t = useTranslations('shell.error');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-3 p-6" data-testid="error-panel">
      <h1 ref={heading} tabIndex={-1} className="text-xl font-semibold focus:outline-none">
        {t('title')}
      </h1>
      <p className="text-sm">{t('body')}</p>
      {error.digest ? (
        <p className="text-sm text-muted-foreground">{t('reference', { digest: error.digest })}</p>
      ) : null}
      <div className="flex gap-3">
        <Button onClick={() => retry()}>{t('retry')}</Button>
        <Link
          href="/"
          className="inline-flex h-10 items-center rounded-md px-4 text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('home')}
        </Link>
      </div>
    </div>
  );
}
