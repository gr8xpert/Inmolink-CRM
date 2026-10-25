import { IMPERSONATION_DEFAULT_MINUTES, IMPERSONATION_MAX_MINUTES, TenantParams } from '@inmolink/contracts';
import { Button, EmptyState, Label } from '@inmolink/ui';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { requireStaff } from '@/server/staff';
import { fetchStaffAuditLog, fetchTenant, fetchTenantMembers } from '@/server/staff-api';
import { fetchAgencyBilling } from '@/server/staff-ops-api';
import { setGiveToGetExemptionAction, startImpersonationAction } from '../../actions';
import { PlanGrants } from './plan-grants';

const ERRORS = ['FORBIDDEN', 'NOT_FOUND', 'IMPERSONATION_TARGET_INVALID', 'VALIDATION_FAILED', 'generic'] as const;
const MINUTES = [15, IMPERSONATION_DEFAULT_MINUTES, IMPERSONATION_MAX_MINUTES];

/**
 * One agency in the staff console (S1-09): company details and verification state, members (with
 * "act as" for support staff), and its latest audit entries (reading them is audited by the API).
 */
export default async function TenantPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const { session, me } = await requireStaff();
  const parsed = TenantParams.safeParse({ agencyId: (await params).id });
  if (!parsed.success) notFound();
  const { agencyId } = parsed.data;
  const canImpersonate = me.role !== 'STAFF_DATA_OPS';
  const [tenant, members, audit, billing] = await Promise.all([
    fetchTenant(session, agencyId),
    canImpersonate ? fetchTenantMembers(session, agencyId) : Promise.resolve(null),
    canImpersonate ? fetchStaffAuditLog(session, { agencyId, limit: 20 }) : Promise.resolve(null),
    fetchAgencyBilling(session, agencyId),
  ]);
  if (tenant === 'revoked' || members === 'revoked' || audit === 'revoked' || billing === 'revoked') {
    redirect('/session/expired');
  }
  if (!tenant.ok && tenant.status === 404) notFound();
  const t = await getTranslations('staff');
  const format = await getFormatter();
  const query = await searchParams;
  const error = ERRORS.find((e) => e === query.error);
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  if (!tenant.ok) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('errors.generic')}
      </p>
    );
  }
  const a = tenant.data;

  return (
    <div className="flex flex-col gap-6">
      <Link href="/staff/tenants" className="text-sm underline-offset-4 hover:underline">
        {t('tenant.back')}
      </Link>
      <h1 className="text-xl font-semibold">{a.name}</h1>
      {query.notice === 'impersonationEnded' ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {t('impersonation.endedNotice')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`impersonation.errors.${error}`)}
        </p>
      ) : null}

      <section aria-labelledby="company-heading" className="flex flex-col gap-2 rounded-md border p-4 text-sm">
        <h2 id="company-heading" className="font-medium">
          {t('tenant.company')}
        </h2>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">{t('tenants.status')}</dt>
          <dd data-testid="tenant-status">{t(`tenants.statuses.${a.status}`)}</dd>
          <dt className="text-muted-foreground">{t('request.kind')}</dt>
          <dd>{a.kind}</dd>
          <dt className="text-muted-foreground">{t('request.taxId')}</dt>
          <dd>{a.taxId ?? '—'}</dd>
          <dt className="text-muted-foreground">{t('tenant.registerNumber')}</dt>
          <dd>{a.registerNumber ?? '—'}</dd>
          <dt className="text-muted-foreground">{t('request.region')}</dt>
          <dd>{[a.city, a.region].filter(Boolean).join(', ') || '—'}</dd>
          <dt className="text-muted-foreground">{t('tenant.onboarded')}</dt>
          <dd>{a.onboarded ? t('tenant.yes') : t('tenant.no')}</dd>
          <dt className="text-muted-foreground">{t('tenant.verification')}</dt>
          <dd>
            {a.verification ? (
              <Link
                href={`/staff/verification/${a.verification.requestId}`}
                className="underline-offset-4 hover:underline"
              >
                {t('tenant.verificationState', {
                  status: t(`queue.tabs.${a.verification.status}`),
                  date: date(a.verification.submittedAt),
                })}
              </Link>
            ) : (
              t('tenant.notSubmitted')
            )}
          </dd>
          <dt className="text-muted-foreground">{t('tenant.created')}</dt>
          <dd>{date(a.createdAt)}</dd>
          <dt className="text-muted-foreground">{t('tenant.giveToGet')}</dt>
          <dd className="flex flex-col gap-2">
            <span data-testid="tenant-give-to-get">
              {a.giveToGetExempt ? t('tenant.giveToGetExempt') : t('tenant.giveToGetRequired')}
            </span>
            {a.giveToGetReason ? (
              <span className="text-xs text-muted-foreground" data-testid="tenant-give-to-get-reason">
                {t('tenant.giveToGetLastReason', { reason: a.giveToGetReason })}
              </span>
            ) : null}
            {/* Support roles only (the API refuses data ops too): a buyer-only agency searches without sharing. */}
            {canImpersonate ? (
              <form action={setGiveToGetExemptionAction} className="flex flex-col gap-2">
                <input type="hidden" name="agencyId" value={a.id} />
                <input type="hidden" name="exempt" value={a.giveToGetExempt ? 'false' : 'true'} />
                <Label htmlFor="give-to-get-reason">{t('tenant.giveToGetReason')}</Label>
                <textarea
                  id="give-to-get-reason"
                  name="reason"
                  required
                  minLength={10}
                  maxLength={500}
                  rows={2}
                  className="rounded-md border bg-background p-2 text-sm"
                />
                <Button type="submit" variant="outline" size="sm" className="self-start">
                  {a.giveToGetExempt ? t('tenant.giveToGetEnd') : t('tenant.giveToGetGrant')}
                </Button>
              </form>
            ) : null}
          </dd>
        </dl>
      </section>

      {/* S13-03: plan grants and founding price locks (super admins change them). */}
      <PlanGrants
        agencyId={a.id}
        data={billing.ok ? billing.data : null}
        canGrant={me.role === 'SUPER_ADMIN'}
        notice={query.billingNotice}
        error={query.billingError}
      />

      {members ? (
        <section aria-labelledby="members-heading" className="flex flex-col gap-2">
          <h2 id="members-heading" className="font-medium">
            {t('tenant.members')}
          </h2>
          {members.ok ? (
            <ul className="divide-y rounded-md border" data-testid="tenant-members">
              {members.data.items.map((m) => (
                <li key={m.userId} className="flex flex-col gap-3 p-3 text-sm">
                  <div>
                    <p className="font-medium">
                      {m.name} · {m.email}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {m.role} · {t(`tenant.memberStatus.${m.status}`)}
                    </p>
                  </div>
                  {canImpersonate && m.status === 'ACTIVE' && a.status !== 'SUSPENDED' ? (
                    <details>
                      <summary className="cursor-pointer font-medium">
                        {t('impersonation.start', { name: m.name })}
                      </summary>
                      <form action={startImpersonationAction} className="mt-2 flex flex-col gap-2">
                        <input type="hidden" name="agencyId" value={a.id} />
                        <input type="hidden" name="userId" value={m.userId} />
                        <Label htmlFor={`reason-${m.userId}`}>{t('impersonation.reason')}</Label>
                        <textarea
                          id={`reason-${m.userId}`}
                          name="reason"
                          required
                          minLength={10}
                          maxLength={500}
                          rows={2}
                          className="rounded-md border bg-background p-2 text-sm"
                        />
                        <Label htmlFor={`minutes-${m.userId}`}>{t('impersonation.minutes')}</Label>
                        <select
                          id={`minutes-${m.userId}`}
                          name="minutes"
                          defaultValue={String(IMPERSONATION_DEFAULT_MINUTES)}
                          className="h-9 w-32 rounded-md border bg-background px-2 text-sm"
                        >
                          {MINUTES.map((n) => (
                            <option key={n} value={n}>
                              {t('impersonation.minutesOption', { minutes: n })}
                            </option>
                          ))}
                        </select>
                        <p className="text-xs text-muted-foreground">{t('impersonation.warning')}</p>
                        <Button type="submit" className="self-start">
                          {t('impersonation.confirm')}
                        </Button>
                      </form>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p role="alert" className="text-sm text-destructive">
              {t('errors.generic')}
            </p>
          )}
        </section>
      ) : null}

      {audit ? (
        <section aria-labelledby="audit-heading" className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 id="audit-heading" className="font-medium">
              {t('tenant.recentAudit')}
            </h2>
            <Link
              href={{ pathname: '/staff/audit', query: { agencyId: a.id } }}
              className="text-sm underline-offset-4 hover:underline"
            >
              {t('tenant.fullAudit')}
            </Link>
          </div>
          {audit.ok ? (
            audit.data.items.length === 0 ? (
              <EmptyState title={t('audit.empty')} />
            ) : (
              <ul className="divide-y rounded-md border text-sm">
                {audit.data.items.map((e) => (
                  <li key={e.id} className="flex flex-wrap justify-between gap-2 p-2">
                    <span className="font-mono text-xs">{e.type}</span>
                    <span className="text-xs text-muted-foreground">{date(e.occurredAt)}</span>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <p role="alert" className="text-sm text-destructive">
              {t('errors.generic')}
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}
