import { notFound, redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { ClientModeUnavailable } from '@/components/shell/client-mode-unavailable';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { agencyTimeZone } from '@/server/agency-time-zone';
import { sessionRef } from '@/server/api';
import { fetchViewingTerms } from '@/server/collaborations-api';
import { inClientMode } from '@/server/nav';
import { loadShell } from '@/server/shell';
import { termsText, termsTools } from '../../../terms-text';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A viewing's terms (S17-F56, `GET /v1/mls/viewing-requests/:id/terms`): the snapshot, who accepted when, and the signed PDF
 * link once the owner accepted and the PDF exists (rendered within seconds; the API asks for it again when missing). Between
 * the agencies only: nothing of the client, and closed in Client Mode.
 */
export default async function ViewingTermsPage(props: { params: Promise<{ id: string }> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const shell = await loadShell();
  if (shell && inClientMode(shell.identity)) return <ClientModeUnavailable />;
  const { id } = await props.params;
  if (!UUID.test(id)) notFound();
  const ref = sessionRef(session.user);
  const [res, timeZone] = await Promise.all([fetchViewingTerms(ref, id), agencyTimeZone(ref)]);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok && res.status === 404) notFound();
  const t = await getTranslations('network.collaborations');
  const format = await getFormatter();
  const commission = await getTranslations('network.commission');
  const dateTime = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short', timeZone });

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('terms.title')}</h1>
        <Link href="/collaborations" className="text-sm underline-offset-4 hover:underline">
          {t('register.back')}
        </Link>
      </div>
      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${res.status === 403 ? 'FORBIDDEN' : 'generic'}`)}
        </p>
      ) : (
        <>
          <p className="rounded-md border p-4 text-sm font-medium">
            {termsText(
              res.data.terms,
              termsTools(format, (key, values) => commission(key, values)),
            )}
          </p>
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{t('terms.validUntil')}</dt>
            <dd>{dateTime(res.data.terms.validUntil)}</dd>
            <dt className="text-muted-foreground">{t('terms.snapshotAt')}</dt>
            <dd>{dateTime(res.data.terms.snapshotAt)}</dd>
            <dt className="text-muted-foreground">{t('terms.introducerAccepted')}</dt>
            <dd>{dateTime(res.data.terms.introducerAcceptedAt)}</dd>
            <dt className="text-muted-foreground">{t('terms.ownerAccepted')}</dt>
            <dd>{res.data.terms.ownerAcceptedAt ? dateTime(res.data.terms.ownerAcceptedAt) : t('terms.notYet')}</dd>
          </dl>
          {res.data.pdfUrl ? (
            <a
              href={res.data.pdfUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="w-fit text-sm font-medium underline underline-offset-4"
            >
              {t('terms.pdf')}
            </a>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {t(res.data.terms.accepted ? 'terms.pdfPending' : 'terms.pdfAfterAccept')}
            </p>
          )}
        </>
      )}
    </div>
  );
}
