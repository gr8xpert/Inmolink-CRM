import { getTranslations } from 'next-intl/server';

/**
 * What a page the API closes in Client Mode shows instead of an error (S17-F35): one sentence. The Client Mode banner is
 * the shell's; the page asks for nothing the server would refuse.
 */
export async function ClientModeUnavailable() {
  const t = await getTranslations('shell');
  return (
    <div className="mx-auto max-w-3xl p-6">
      <p role="status" className="rounded-md bg-muted p-3 text-sm" data-testid="client-mode-unavailable">
        {t('clientModeUnavailable')}
      </p>
    </div>
  );
}
