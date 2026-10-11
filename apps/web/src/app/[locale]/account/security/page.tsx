import { authCtx } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import { newId } from '@inmolink/platform/ids';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname, Link, redirect } from '@/i18n/navigation';
import { webConfig } from '@/server/env';
import { twoFactorErrors } from '@/server/form-errors';
import { disableAction, regenerateCodesAction } from '../../(auth)/two-factor/actions';
import { CodeForm } from '../../(auth)/two-factor/code-form';

/**
 * Account security (S1-04): two-step verification status, new recovery codes, and turning it off
 * (opted-in users only). A session that still owes its second factor is sent to the challenge first.
 */
export default async function SecurityPage() {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return redirect({ href: '/login', locale });
  await webConfig();
  const status = await identity.getTwoFactorStatus(authCtx(newId()), { userId: session.user.id });
  if ((status.enabled || status.required) && !session.user.mfaVerified)
    return redirect({ href: '/two-factor', locale });
  const t = await getTranslations('security');
  const errors = await twoFactorErrors();
  const here = getPathname({ href: '/account/security', locale });

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-6">
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
    </main>
  );
}
