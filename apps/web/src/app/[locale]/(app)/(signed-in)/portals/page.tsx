import type { PortalConnectionDto } from '@inmolink/contracts';
import { EmptyState, Input, Label } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname, Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchPortalChannels, fetchPortalConnections, sessionRef } from '@/server/api';
import { PortalNotice } from './notice';
import { createPortalAction } from './portal-actions';
import { PORTAL_ERRORS, type PortalError } from './portal-state';
import { RuleFields, SELECT } from './rule-fields';
import { IssueTokenForm } from './token-form';

const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * Portals (S9-01, PLAN §7 M7): the agency's connections to listing portals, each with the rule that picks the
 * listings it sends; admins connect a portal (the feed token is shown once) and open a connection to change it (the
 * API refuses everyone else).
 */
export default async function PortalsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const params = await searchParams;
  const cursor = typeof params.cursor === 'string' && CURSOR.test(params.cursor) ? params.cursor : undefined;
  const ref = sessionRef(session.user);
  const [res, channels] = await Promise.all([fetchPortalConnections(ref, cursor), fetchPortalChannels(ref)]);
  if (res === 'revoked' || channels === 'revoked') redirect('/session/expired');
  const t = await getTranslations('portals');
  const errors = Object.fromEntries([...PORTAL_ERRORS, 'generic' as const].map((c) => [c, t(`errors.${c}`)])) as Record<
    PortalError,
    string
  >;
  const available = channels.ok ? channels.data.items : [];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <PortalNotice done={params.done} error={params.error} />
      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      ) : res.data.items.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-sm" data-testid="portal-connections">
            <thead className="bg-muted">
              <tr>
                <th className="p-2">{t('columns.name')}</th>
                <th className="p-2">{t('columns.portal')}</th>
                <th className="p-2">{t('columns.rule')}</th>
                <th className="p-2">{t('columns.choices')}</th>
                <th className="p-2">{t('columns.status')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {res.data.items.map((c: PortalConnectionDto) => (
                <tr key={c.id}>
                  <td className="p-2">
                    <Link href={`/portals/${c.id}`} className="font-medium underline-offset-4 hover:underline">
                      {c.name}
                    </Link>
                  </td>
                  <td className="p-2">{available.find((ch) => ch.code === c.channelCode)?.name ?? c.channelCode}</td>
                  <td className="p-2">
                    {t(`rule.modes.${c.selection.mode}`)}
                    {c.selection.tag ? <span className="ml-1 font-mono text-xs">#{c.selection.tag}</span> : null}
                  </td>
                  <td className="p-2 text-xs">
                    {t('choicesCount', { include: c.includeCount, exclude: c.excludeCount })}
                  </td>
                  <td className="p-2">{c.enabled ? t('on') : t('off')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {res.ok && res.data.nextCursor ? (
        <Link
          href={{ pathname: '/portals', query: { cursor: res.data.nextCursor } }}
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('next')}
        </Link>
      ) : null}
      <section className="flex flex-col gap-3 rounded-md border p-4" aria-labelledby="portal-add-title">
        <h2 id="portal-add-title" className="text-lg font-semibold">
          {t('add.title')}
        </h2>
        <IssueTokenForm
          action={createPortalAction}
          doneBase={getPathname({ href: '/portals', locale })}
          submit={t('add.submit')}
          issued={{
            title: t('issued.title'),
            intro: t('issued.intro'),
            token: t('issued.token'),
            done: t('issued.done'),
          }}
          errors={errors}
        >
          <Label htmlFor="portal-channel">{t('add.portal')}</Label>
          <select id="portal-channel" name="channelCode" className={SELECT} required>
            {available.map((ch) => (
              <option key={ch.code} value={ch.code} disabled={ch.status !== 'AVAILABLE'}>
                {ch.name}
                {ch.status !== 'AVAILABLE' ? ` — ${t('planned')}` : ''}
              </option>
            ))}
          </select>
          <Label htmlFor="portal-name">{t('add.name')}</Label>
          <Input id="portal-name" name="name" maxLength={80} required />
          <RuleFields idPrefix="portal-new" selection={{ mode: 'ALL_PUBLIC', tag: null }} />
          <Label htmlFor="portal-credentials">{t('add.credentials')}</Label>
          <textarea
            id="portal-credentials"
            name="credentials"
            rows={2}
            className={SELECT}
            aria-describedby="portal-credentials-hint"
          />
          <p id="portal-credentials-hint" className="text-xs text-muted-foreground">
            {t('add.credentialsHint')}
          </p>
        </IssueTokenForm>
      </section>
    </div>
  );
}
