import { getTranslations } from 'next-intl/server';
import { SITE_NOTICE_ERRORS } from './errors';

/** The notice or error a website form came back with (`?done=` / `?error=`). Server component. */
export async function SiteNotice({ done, error }: { done?: string; error?: string }) {
  const t = await getTranslations('websites');
  if (done === 'created' || done === 'saved') {
    return (
      <p role="status" className="rounded-md border bg-muted p-3 text-sm">
        {t(`notices.${done}`)}
      </p>
    );
  }
  if (!error) return null;
  const code = SITE_NOTICE_ERRORS.find((c) => c === error);
  return (
    <p role="alert" className="text-sm text-destructive">
      {code ? t(`errors.${code}`) : t('errors.generic')}
    </p>
  );
}
