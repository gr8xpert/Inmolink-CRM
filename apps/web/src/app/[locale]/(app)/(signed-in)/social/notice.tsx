import { getTranslations } from 'next-intl/server';
import { SOCIAL_DONE, SOCIAL_NOTICE_ERRORS } from './errors';

/** The notice or error a social form came back with (`?done=` / `?error=`). Server component. */
export async function SocialNotice({ done, error }: { done?: string; error?: string }) {
  const t = await getTranslations('social');
  const ok = SOCIAL_DONE.find((d) => d === done);
  if (ok) {
    return (
      <p role="status" className="rounded-md border bg-muted p-3 text-sm">
        {t(`notices.${ok}`)}
      </p>
    );
  }
  if (!error) return null;
  const code = SOCIAL_NOTICE_ERRORS.find((c) => c === error);
  return (
    <p role="alert" className="text-sm text-destructive">
      {code ? t(`errors.${code}`) : t('errors.generic')}
    </p>
  );
}
