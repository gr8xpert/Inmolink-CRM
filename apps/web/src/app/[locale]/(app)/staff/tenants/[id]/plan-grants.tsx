import { BillingCurrency, BillingInterval, type StaffAgencyBillingDto } from '@inmolink/contracts';
import { Button, EmptyState, Input, Label } from '@inmolink/ui';
import { getFormatter, getTranslations } from 'next-intl/server';
import { grantPlanAction, revokePlanGrantAction, setPriceLockAction } from './billing-actions';

const ERRORS = ['FORBIDDEN', 'BILLING_PRICE_UNAVAILABLE', 'BILLING_GRANT_NOT_FOUND', 'VALIDATION_FAILED'] as const;

/**
 * An agency's plan grants and founding price locks in the staff console (S13-03). Every staff role sees them; super
 * admins grant, revoke (with a reason, kept in the audit log) and set price locks. Server component; forms post to
 * server actions.
 */
export async function PlanGrants({
  agencyId,
  data,
  canGrant,
  notice,
  error,
}: {
  agencyId: string;
  data: StaffAgencyBillingDto | null;
  canGrant: boolean;
  notice?: string;
  error?: string;
}) {
  const t = await getTranslations('staff');
  const format = await getFormatter();
  const day = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });
  const err = error ? (ERRORS.find((c) => c === error) ?? 'generic') : null;
  const note = notice === 'granted' || notice === 'revoked' || notice === 'locked' ? notice : null;
  const now = Date.now();

  return (
    <section
      id="billing"
      aria-labelledby="billing-heading"
      className="flex flex-col gap-3 rounded-md border p-4 text-sm"
    >
      <h2 id="billing-heading" className="font-medium">
        {t('ops.billing.title')}
      </h2>
      {note ? (
        <p role="status" className="rounded-md bg-muted p-3">
          {t(`ops.billing.notices.${note}`)}
        </p>
      ) : null}
      {err ? (
        <p role="alert" className="text-destructive">
          {err === 'generic' ? t('errors.generic') : t(`ops.billing.errors.${err}`)}
        </p>
      ) : null}
      {data === null ? (
        <p role="alert" className="text-destructive">
          {t('errors.generic')}
        </p>
      ) : (
        <>
          <h3 className="font-medium">{t('ops.billing.grants')}</h3>
          {data.grants.length === 0 ? (
            <EmptyState title={t('ops.billing.noGrants')} />
          ) : (
            <ul className="divide-y rounded-md border" data-testid="plan-grants">
              {data.grants.map((g) => {
                const running = !g.revokedAt && new Date(g.endsAt).getTime() > now;
                return (
                  <li key={g.id} className="flex flex-col gap-2 p-3">
                    <p>
                      <span className="font-medium">{g.planCode}</span> · {t(`ops.billing.kinds.${g.kind}`)} ·{' '}
                      {t('ops.billing.period', { start: day(g.startsAt), end: day(g.endsAt) })}
                      {g.revokedAt ? ` · ${t('ops.billing.revokedOn', { date: day(g.revokedAt) })}` : ''}
                    </p>
                    {/* Staff-entered text: rendered as text. */}
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">{g.reason}</p>
                    {g.revokeReason ? (
                      <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                        {t('ops.billing.revokeReasonShown', { reason: g.revokeReason })}
                      </p>
                    ) : null}
                    {canGrant && running && g.kind === 'STAFF' ? (
                      <form action={revokePlanGrantAction} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="agencyId" value={agencyId} />
                        <input type="hidden" name="grantId" value={g.id} />
                        <div className="flex flex-col gap-1">
                          <Label htmlFor={`revoke-${g.id}`}>{t('ops.billing.revokeReason')}</Label>
                          <Input
                            id={`revoke-${g.id}`}
                            name="reason"
                            required
                            minLength={10}
                            maxLength={500}
                            className="w-80"
                          />
                        </div>
                        <Button type="submit" size="sm" variant="outline">
                          {t('ops.billing.revoke')}
                        </Button>
                      </form>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          <h3 className="font-medium">{t('ops.billing.locks')}</h3>
          {data.priceLocks.length === 0 ? (
            <EmptyState title={t('ops.billing.noLocks')} />
          ) : (
            <ul className="divide-y rounded-md border" data-testid="price-locks">
              {data.priceLocks.map((l) => (
                <li key={l.id} className="flex flex-col gap-1 p-3">
                  <p>
                    <span className="font-medium">{l.planCode}</span> ·{' '}
                    {BillingInterval.safeParse(l.interval).success
                      ? t(`ops.billing.intervals.${l.interval as BillingInterval}`)
                      : l.interval}{' '}
                    · {format.number(l.amountCents / 100, { style: 'currency', currency: l.currency })} ·{' '}
                    {day(l.endsAt)}
                  </p>
                  <p className="whitespace-pre-wrap text-xs text-muted-foreground">{l.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {canGrant ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <form action={grantPlanAction} className="flex flex-col gap-2 rounded-md border p-3">
            <h3 className="font-medium">{t('ops.billing.grantTitle')}</h3>
            <input type="hidden" name="agencyId" value={agencyId} />
            <Label htmlFor="grant-plan">{t('ops.billing.planCode')}</Label>
            <Input id="grant-plan" name="planCode" required pattern="[a-z][a-z0-9_]{1,39}" autoComplete="off" />
            <Label htmlFor="grant-ends">{t('ops.billing.endsAt')}</Label>
            <Input id="grant-ends" name="endsAt" type="date" required />
            <Label htmlFor="grant-reason">{t('ops.billing.reason')}</Label>
            <Input id="grant-reason" name="reason" required minLength={3} maxLength={500} />
            <Button type="submit" size="sm" className="self-start">
              {t('ops.billing.grant')}
            </Button>
          </form>
          <form action={setPriceLockAction} className="flex flex-col gap-2 rounded-md border p-3">
            <h3 className="font-medium">{t('ops.billing.lockTitle')}</h3>
            <input type="hidden" name="agencyId" value={agencyId} />
            <Label htmlFor="lock-plan">{t('ops.billing.planCode')}</Label>
            <Input id="lock-plan" name="planCode" required pattern="[a-z][a-z0-9_]{1,39}" autoComplete="off" />
            <Label htmlFor="lock-interval">{t('ops.billing.interval')}</Label>
            <select id="lock-interval" name="interval" className="h-9 rounded-md border bg-background px-2 text-sm">
              {BillingInterval.options.map((i) => (
                <option key={i} value={i}>
                  {t(`ops.billing.intervals.${i}`)}
                </option>
              ))}
            </select>
            <Label htmlFor="lock-currency">{t('ops.billing.currency')}</Label>
            <select id="lock-currency" name="currency" className="h-9 rounded-md border bg-background px-2 text-sm">
              {BillingCurrency.options.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <Label htmlFor="lock-amount">{t('ops.billing.amount')}</Label>
            <Input id="lock-amount" name="amount" type="number" min={0} step="0.01" required />
            <Label htmlFor="lock-ends">{t('ops.billing.endsAt')}</Label>
            <Input id="lock-ends" name="endsAt" type="date" required />
            <Label htmlFor="lock-reason">{t('ops.billing.reason')}</Label>
            <Input id="lock-reason" name="reason" required minLength={3} maxLength={500} />
            <Button type="submit" size="sm" className="self-start">
              {t('ops.billing.setLock')}
            </Button>
          </form>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t('ops.billing.superAdminOnly')}</p>
      )}
    </section>
  );
}
