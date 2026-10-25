import * as identity from '@inmolink/core/modules/identity';
import { Button } from '@inmolink/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { disableAction, forgetBrowsersAction, regenerateCodesAction } from '@/app/[locale]/(auth)/two-factor/actions';
import { CodeForm } from '@/app/[locale]/(auth)/two-factor/code-form';
import { auth } from '@/auth';
import { getPathname, Link, redirect } from '@/i18n/navigation';
import { inClientMode } from '@/server/client-mode';
import { webConfig } from '@/server/env';
import { twoFactorErrors } from '@/server/form-errors';
import { readImpersonation } from '@/server/impersonation';
import { requestAuthCtx } from '@/server/request-id';

/**
 * Account security (S1-04): two-step verification status, new recovery codes, and turning it off
 * (opted-in users only), and forgetting remembered browsers. A session that still owes its second
 * factor is sent to the challenge first; none of it is reachable while impersonating (S1-09).
 */
export default async function SecurityPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return redirect({ href: '/login', locale });
  await webConfig();
  if (await readImpersonation(session.user.id)) return redirect({ href: '/', locale });
  // S12-06 review: never in Client Mode (a client at the screen must not change the member's second factor).
  if (await inClientMode(session.user)) return redirect({ href: '/', locale });
  const forgotten = (await searchParams).forgotten === '1';
  const status = await identity.getTwoFactorStatus(await requestAuthCtx(), { userId: session.user.id });
  if ((status.enabled || status.required) && !session.user.mfaVerified)
    return redirect({ href: '/two-factor', locale });
  const t = await getTranslations('security');
  const errors = await twoFactorErrors();
  const here = getPathname({ href: '/account/security', locale });

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('account.title')}</h1>
        <Link href="/" className="text-sm underline-offset-4 hover:underline">
          {t('account.back')}
        </Link>
      </div>
      <section className="flex flex-col gap-2 text-sm" data-testid="two-factor-status">
        <p>{status.enabled ? t('account.on') : t('account.off')}</p>
        {status.enabled ? <p>{t('account.codesLeft', { count: status.recoveryCodesLeft })}</p> : null}
        {status.required ? <p className="text-muted-foreground">{t('account.required')}</p> : null}
        {status.enabled ? null : (
          <Link
            href={{ pathname: '/two-factor', query: { setup: '1' } }}
            className="font-medium underline-offset-4 hover:underline"
          >
            {t('account.setUp')}
          </Link>
        )}
      </section>
      {status.enabled ? (
        <section className="flex flex-col gap-3 rounded-md border p-4">
          <h2 className="font-semibold">{t('account.regenerateTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('account.regenerateIntro')}</p>
          <CodeForm
            action={regenerateCodesAction}
            codeLabel={t('account.code')}
            submitLabel={t('account.regenerate')}
            errors={errors}
            codes={{
              title: t('enrol.codesTitle'),
              intro: t('enrol.codesIntro'),
              continueLabel: t('enrol.continue'),
              continueHref: here,
            }}
          />
        </section>
      ) : null}
      {status.enabled ? (
        <section className="flex flex-col gap-3 rounded-md border p-4">
          <h2 className="font-semibold">{t('account.forgetTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('account.forgetIntro')}</p>
          {forgotten ? (
            <p role="status" data-testid="devices-forgotten" className="rounded-md bg-muted p-3 text-sm">
              {t('account.forgotten')}
            </p>
          ) : null}
          <form action={forgetBrowsersAction}>
            <Button type="submit" variant="outline">
              {t('account.forget')}
            </Button>
          </form>
        </section>
      ) : null}
      {status.enabled && !status.required ? (
        <section className="flex flex-col gap-3 rounded-md border p-4">
          <h2 className="font-semibold">{t('account.disableTitle')}</h2>
          <CodeForm
            action={disableAction}
            codeLabel={t('account.code')}
            submitLabel={t('account.disable')}
            errors={errors}
            doneMessage={t('account.disabled')}
            variant="destructive"
          />
        </section>
      ) : null}
    </div>
  );
}
