import type { InvitableRole, MemberDto } from '@inmolink/contracts';
import { UI_LOCALES } from '@inmolink/i18n';
import { Button, EmptyState, Input, Label } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { redirect as localeRedirect } from '@/i18n/navigation';
import { fetchTeam, sessionRef } from '@/server/api';
import { changeRoleAction, deactivateAction, inviteAction, revokeInviteAction } from './actions';

/** Roles an admin hands out (mirrors the identity policy; the API enforces it). */
const MANAGED: Record<string, InvitableRole[]> = {
  AGENCY_ADMIN: ['AGENCY_ADMIN', 'AGENT'],
  DEVELOPER_ADMIN: ['DEVELOPER_ADMIN', 'DEVELOPER_AGENT'],
};

const NOTICES = ['invited', 'roleChanged', 'deactivated', 'revoked'] as const;
const ERRORS = ['FORBIDDEN', 'NOT_FOUND', 'ALREADY_MEMBER', 'VALIDATION_FAILED', 'RATE_LIMITED', 'generic'] as const;

/** Team (S1-02): members for everyone; invites, role changes and deactivation for admins. */
export default async function TeamPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const res = await fetchTeam(sessionRef(session.user));
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('team');
  const format = await getFormatter();
  const params = await searchParams;
  const notice = NOTICES.find((n) => n === params.notice);
  const error = ERRORS.find((e) => e === params.error);

  if (!res.members.ok) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      </div>
    );
  }
  const members = res.members.data.items;
  const me = members.find((m) => m.userId === session.user?.id);
  const managed = (me && MANAGED[me.role]) ?? [];
  const canManage = res.invites !== null && managed.length > 0;
  const roleLabel = (role: string) => t(`roles.${role}` as never);
  const manageable = (m: MemberDto) =>
    canManage && m.userId !== me?.userId && managed.includes(m.role as InvitableRole);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      {notice ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {t(`notices.${notice}`)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${error}`)}
        </p>
      ) : null}

      <section aria-labelledby="members-heading" className="flex flex-col gap-2">
        <h2 id="members-heading" className="font-medium">
          {t('members')}
        </h2>
        <ul className="divide-y rounded-md border" data-testid="team-members">
          {members.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{m.name}</p>
                <p className="truncate text-xs text-muted-foreground">{m.email}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {m.status === 'DEACTIVATED' ? (
                  <span className="rounded-full bg-muted px-3 py-1 text-xs">{t('deactivatedBadge')}</span>
                ) : null}
                {manageable(m) && m.status === 'ACTIVE' ? (
                  <>
                    <form action={changeRoleAction} className="flex items-center gap-2">
                      <input type="hidden" name="userId" value={m.userId} />
                      <label className="sr-only" htmlFor={`role-${m.userId}`}>
                        {t('role')}
                      </label>
                      <select
                        id={`role-${m.userId}`}
                        name="role"
                        defaultValue={m.role}
                        className="h-9 rounded-md border bg-background px-2 text-sm"
                      >
                        {managed.map((r) => (
                          <option key={r} value={r}>
                            {roleLabel(r)}
                          </option>
                        ))}
                      </select>
                      <Button type="submit" variant="outline" size="sm">
                        {t('saveRole')}
                      </Button>
                    </form>
                    <form action={deactivateAction}>
                      <input type="hidden" name="userId" value={m.userId} />
                      <Button type="submit" variant="outline" size="sm">
                        {t('deactivate')}
                      </Button>
                    </form>
                  </>
                ) : (
                  <span>{roleLabel(m.role)}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {canManage && res.invites ? (
        <>
          <section aria-labelledby="invite-heading" className="flex flex-col gap-3">
            <h2 id="invite-heading" className="font-medium">
              {t('invite.title')}
            </h2>
            <form action={inviteAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex flex-1 flex-col gap-2">
                <Label htmlFor="invite-email">{t('invite.email')}</Label>
                <Input id="invite-email" name="email" type="email" autoComplete="off" required />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="invite-role">{t('role')}</Label>
                <select
                  id="invite-role"
                  name="role"
                  defaultValue={managed.at(-1)}
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                >
                  {managed.map((r) => (
                    <option key={r} value={r}>
                      {roleLabel(r)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="invite-locale">{t('invite.language')}</Label>
                <select
                  id="invite-locale"
                  name="locale"
                  defaultValue={locale}
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                >
                  {UI_LOCALES.map((l) => (
                    <option key={l} value={l}>
                      {t(`languages.${l}` as never)}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit">{t('invite.submit')}</Button>
            </form>
            <p className="text-xs text-muted-foreground">{t('invite.hint')}</p>
          </section>

          <section aria-labelledby="pending-heading" className="flex flex-col gap-2">
            <h2 id="pending-heading" className="font-medium">
              {t('pending')}
            </h2>
            {res.invites.items.length === 0 ? (
              <EmptyState title={t('noPending')} />
            ) : (
              <ul className="divide-y rounded-md border" data-testid="team-invites">
                {res.invites.items.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                    <div className="min-w-0">
                      <p className="truncate">{i.email}</p>
                      <p className="text-xs text-muted-foreground">
                        {roleLabel(i.role)} ·{' '}
                        {t('expires', { date: format.dateTime(new Date(i.expiresAt), { dateStyle: 'medium' }) })}
                      </p>
                    </div>
                    <form action={revokeInviteAction}>
                      <input type="hidden" name="inviteId" value={i.id} />
                      <Button type="submit" variant="outline" size="sm">
                        {t('revoke')}
                      </Button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
