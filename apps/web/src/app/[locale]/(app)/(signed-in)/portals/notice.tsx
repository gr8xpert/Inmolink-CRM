import { getTranslations } from 'next-intl/server';
import { PORTAL_ERRORS } from './portal-state';

const DONE = ['saved', 'revoked', 'deleted', 'chosen'] as const;

/** The notice or error a portal form came back with (`?done=` / `?error=`). Server component. */
export async function PortalNotice({ done, error }: { done?: string; error?: string }) {
  const t = await getTranslations('portals');
  const ok = DONE.find((d) => d === done);
  if (ok) {
    return (
      <p role="status" className="rounded-md border bg-muted p-3 text-sm">
        {t(`notices.${ok}`)}
      </p>
    );
  }
  if (!error) return null;
  const code = PORTAL_ERRORS.find((c) => c === error);
  return (
    <p role="alert" className="text-sm text-destructive">
      {code ? t(`errors.${code}`) : t('errors.generic')}
    </p>
  );
}
