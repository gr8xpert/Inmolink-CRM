import { authCtx } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import { newId } from '@inmolink/platform/ids';
import { Button } from '@inmolink/ui';
import { headers } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import QRCode from 'qrcode';
import { auth } from '@/auth';
import { getPathname, redirect } from '@/i18n/navigation';
import { webConfig } from '@/server/env';
import { twoFactorErrors } from '@/server/form-errors';
import { logoutAction } from '../actions';
import { challengeAction, enrolAction } from './actions';
import { CodeForm } from './code-form';

/**
 * Second factor (S1-04). Enabled → the login challenge. Not enabled → enrolment: required for staff
 * and admins (their mints are refused until then), optional for others (`?setup=1` from the security
 * page). A session that already passed goes on to the dashboard.
 */
export default async function TwoFactorPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return redirect({ href: '/login', locale });
  await webConfig();
  const userId = session.user.id;
  const status = await identity.getTwoFactorStatus(authCtx(newId()), { userId });
  const setup = (await searchParams).setup === '1';
  // The render that follows a server action on this page (it carries `Next-Action`) never redirects:
  // after enrolment the form must stay on screen with the recovery codes the action returned, whatever
  // session that render happens to see (S1-F1 review).
  const afterAction = (await headers()).has('next-action');
  const done = status.enabled ? session.user.mfaVerified : !status.required && !setup;
  if (done && !afterAction) return redirect({ href: '/', locale });

  const t = await getTranslations('security');
  const errors = await twoFactorErrors();
  const logout = (
    <form action={logoutAction} className="mt-4">
      <Button type="submit" variant="outline" size="sm">
        {t('challenge.logout')}
      </Button>
    </form>
  );

  // One tree shape for both views, with the form at the same position: Next re-renders this page right
  // after the enrolment action, and 2FA is now enabled, so that render picks the challenge view. Keeping
  // the form in place keeps its state — the recovery codes the action returned — on screen (S1-F1).
  const codes = {
    title: t('enrol.codesTitle'),
    intro: t('enrol.codesIntro'),
    continueLabel: t('enrol.continue'),
    continueHref: getPathname({ href: '/', locale }),
  };
  const enrolment = status.enabled ? null : await identity.startEnrolment(authCtx(newId()), { userId });
  const qr = enrolment
    ? await QRCode.toString(enrolment.uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
    : null;
  return (
    <>
      <h1 className="mb-2 text-xl font-semibold">{enrolment ? t('enrol.title') : t('challenge.title')}</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        {enrolment ? (status.required ? t('enrol.intro') : t('enrol.introOptional')) : t('challenge.intro')}
      </p>
      {enrolment && qr ? (
        <div>
          <p className="mb-2 text-sm">{t('enrol.scan')}</p>
          {/* biome-ignore lint/performance/noImgElement: a generated QR code as a data URL (nothing to optimise); an <img> keeps the SVG inert. */}
          <img
            src={`data:image/svg+xml;base64,${Buffer.from(qr).toString('base64')}`}
            alt={t('enrol.qrAlt')}
            width={192}
            height={192}
            className="mx-auto mb-2"
          />
          <p className="mb-4 text-center text-xs">
            {t('enrol.secret')}:{' '}
            <code data-testid="totp-secret" className="break-all font-mono">
              {enrolment.secret.replace(/(.{4})/g, '$1 ').trim()}
            </code>
          </p>
        </div>
      ) : null}
      {enrolment ? (
        <CodeForm
          action={enrolAction}
          codeLabel={t('enrol.code')}
          submitLabel={t('enrol.submit')}
          errors={errors}
          codes={codes}
        />
      ) : (
        <CodeForm
          action={challengeAction}
          codeLabel={t('challenge.code')}
          submitLabel={t('challenge.submit')}
          rememberLabel={t('challenge.remember')}
          errors={errors}
          codes={codes}
        />
      )}
      {logout}
    </>
  );
}
