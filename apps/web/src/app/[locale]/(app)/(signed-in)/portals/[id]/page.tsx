import { Button, Input, Label } from '@inmolink/ui';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname, Link, redirect as localeRedirect } from '@/i18n/navigation';
import {
  fetchPortalChannels,
  fetchPortalConnection,
  fetchPortalOverrides,
  fetchPortalSelection,
  sessionRef,
} from '@/server/api';
import { PortalNotice } from '../notice';
import {
  choosePropertiesAction,
  clearPropertyAction,
  deletePortalAction,
  revokeTokenAction,
  rotateTokenAction,
  updatePortalAction,
} from '../portal-actions';
import { PORTAL_ERRORS, type PortalError } from '../portal-state';
import { RuleFields, SELECT } from '../rule-fields';
import { IssueTokenForm } from '../token-form';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One portal connection (S9-01): its setup and selection rule, the feed token (rotate or turn off), the listings
 * chosen one by one, and a preview of what it sends now. Members see it; only admins can change it (the API refuses
 * everyone else).
 */
export default async function PortalConnectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ref = sessionRef(session.user);
  const [res, channels, overrides, selection] = await Promise.all([
    fetchPortalConnection(ref, id),
    fetchPortalChannels(ref),
    fetchPortalOverrides(ref, id),
    fetchPortalSelection(ref, id),
  ]);
  if (res === 'revoked' || channels === 'revoked' || overrides === 'revoked' || selection === 'revoked') {
    redirect('/session/expired');
  }
  if (!res.ok && res.status === 404) notFound();
  const t = await getTranslations('portals');
  const fmt = await getFormatter();
  const q = await searchParams;
  if (!res.ok) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      </div>
    );
  }
  const c = res.data;
  const channel = channels.ok ? channels.data.items.find((ch) => ch.code === c.channelCode) : undefined;
  const errors = Object.fromEntries(
    [...PORTAL_ERRORS, 'generic' as const].map((code) => [code, t(`errors.${code}`)]),
  ) as Record<PortalError, string>;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div>
        <Link href="/portals" className="text-sm underline-offset-4 hover:underline">
          {t('back')}
        </Link>
        <h1 className="mt-2 text-xl font-semibold">{t('detail.title', { name: c.name })}</h1>
        <p className="text-sm text-muted-foreground">{channel?.name ?? c.channelCode}</p>
      </div>
      <PortalNotice done={q.done} error={q.error} />

      <section className="flex flex-col gap-3 rounded-md border p-4" aria-labelledby="portal-setup-title">
        <h2 id="portal-setup-title" className="text-lg font-semibold">
          {t('detail.setup')}
        </h2>
        <form action={updatePortalAction} className="flex flex-col gap-3">
          <input type="hidden" name="connectionId" value={c.id} />
          <input type="hidden" name="version" value={c.version} />
          <Label htmlFor="portal-edit-name">{t('add.name')}</Label>
          <Input id="portal-edit-name" name="name" maxLength={80} defaultValue={c.name} required />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="enabled" defaultChecked={c.enabled} />
            {t('detail.enabled')}
          </label>
          <RuleFields idPrefix="portal-edit" selection={c.selection} />
          <Label htmlFor="portal-edit-credentials">{t('detail.credentials')}</Label>
          <p className="text-xs text-muted-foreground">
            {c.credentialKeys.length > 0
              ? t('detail.credentialsStored', { keys: c.credentialKeys.join(', ') })
              : t('detail.credentialsNone')}
            {channel && channel.credentialFields.length > 0
              ? ` ${t('detail.credentialsFields', { keys: channel.credentialFields.join(', ') })}`
              : ''}
          </p>
          <textarea id="portal-edit-credentials" name="credentials" rows={2} className={SELECT} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="removeCredentials" />
            {t('detail.removeCredentials')}
          </label>
          <Button type="submit" size="sm" className="self-start">
            {t('detail.save')}
          </Button>
        </form>
      </section>

      <section className="flex flex-col gap-3 rounded-md border p-4" aria-labelledby="portal-token-title">
        <h2 id="portal-token-title" className="text-lg font-semibold">
          {t('token.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('token.intro')}</p>
        <p className="text-sm" data-testid="portal-token-status">
          {c.tokenActive
            ? t('token.active', {
                hint: c.tokenHint,
                date: fmt.dateTime(new Date(c.tokenCreatedAt), { dateStyle: 'medium' }),
              })
            : t('token.revoked')}
        </p>
        <div className="flex flex-wrap items-start gap-4">
          <IssueTokenForm
            action={rotateTokenAction}
            doneBase={getPathname({ href: '/portals', locale })}
            submit={c.tokenActive ? t('token.rotate') : t('token.turnOn')}
            issued={{
              title: t('issued.title'),
              intro: t('issued.intro'),
              token: t('issued.token'),
              done: t('issued.done'),
            }}
            errors={errors}
          >
            <input type="hidden" name="connectionId" value={c.id} />
          </IssueTokenForm>
          {c.tokenActive ? (
            <form action={revokeTokenAction}>
              <input type="hidden" name="connectionId" value={c.id} />
              <Button type="submit" variant="outline" size="sm">
                {t('token.turnOff')}
              </Button>
            </form>
          ) : null}
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-md border p-4" aria-labelledby="portal-choices-title">
        <h2 id="portal-choices-title" className="text-lg font-semibold">
          {t('choices.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('choices.intro')}</p>
        {overrides.ok && overrides.data.items.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm" data-testid="portal-overrides">
            {overrides.data.items.map((o) => (
              <li key={o.propertyId} className="flex items-center gap-3">
                <span className="font-mono text-xs">{o.ref ?? o.propertyId}</span>
                <span>{t(`choices.actions.${o.action}`)}</span>
                <form action={clearPropertyAction}>
                  <input type="hidden" name="connectionId" value={c.id} />
                  <input type="hidden" name="propertyId" value={o.propertyId} />
                  <Button type="submit" variant="outline" size="sm">
                    {t('choices.clear')}
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t('choices.none')}</p>
        )}
        <form action={choosePropertiesAction} className="flex flex-col gap-2">
          <input type="hidden" name="connectionId" value={c.id} />
          <Label htmlFor="portal-refs">{t('choices.refs')}</Label>
          <textarea
            id="portal-refs"
            name="refs"
            rows={3}
            className={SELECT}
            aria-describedby="portal-refs-hint"
            required
          />
          <p id="portal-refs-hint" className="text-xs text-muted-foreground">
            {t('choices.refsHint')}
          </p>
          <Label htmlFor="portal-choice-action">{t('choices.action')}</Label>
          <select id="portal-choice-action" name="action" className={SELECT}>
            <option value="INCLUDE">{t('choices.actions.INCLUDE')}</option>
            <option value="EXCLUDE">{t('choices.actions.EXCLUDE')}</option>
            <option value="CLEAR">{t('choices.actions.CLEAR')}</option>
          </select>
          <Button type="submit" size="sm" className="self-start">
            {t('choices.apply')}
          </Button>
        </form>
      </section>

      <section className="flex flex-col gap-3 rounded-md border p-4" aria-labelledby="portal-preview-title">
        <h2 id="portal-preview-title" className="text-lg font-semibold">
          {t('preview.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('preview.intro')}</p>
        {selection.ok && selection.data.items.length > 0 ? (
          <ul className="grid grid-cols-2 gap-1 font-mono text-xs sm:grid-cols-4" data-testid="portal-selection">
            {selection.data.items.map((l) => (
              <li key={l.propertyId}>{l.ref ?? l.propertyId}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t('preview.empty')}</p>
        )}
        {selection.ok && selection.data.nextCursor ? (
          <p className="text-xs text-muted-foreground">{t('preview.more')}</p>
        ) : null}
      </section>

      <form action={deletePortalAction}>
        <input type="hidden" name="connectionId" value={c.id} />
        <Button type="submit" variant="outline" size="sm">
          {t('detail.delete')}
        </Button>
      </form>
    </div>
  );
}
