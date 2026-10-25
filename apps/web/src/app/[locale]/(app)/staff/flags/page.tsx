import { Button, EmptyState, Input, Label } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireStaff } from '@/server/staff';
import { fetchFeatureFlags } from '@/server/staff-ops-api';
import { setFeatureFlagAction } from './actions';

const ERRORS = ['FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'] as const;

/**
 * Feature flags (S13-03, PLAN §3 #42): every flag with its default and per-agency overrides. Super admins switch the
 * default or set an agency's override; every staff role may look. Changes are live within 60 s and audited.
 */
export default async function StaffFlagsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const { session, me } = await requireStaff();
  const res = await fetchFeatureFlags(session);
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('staff');
  const params = await searchParams;
  const error = params.error ? (ERRORS.find((c) => c === params.error) ?? 'generic') : null;
  const canSet = me.role === 'SUPER_ADMIN';

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">{t('ops.flags.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('ops.flags.intro')}</p>
      {!canSet ? <p className="text-sm text-muted-foreground">{t('ops.flags.readOnly')}</p> : null}
      {params.notice === 'saved' ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {t('ops.flags.notices.saved')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error === 'generic' ? t('errors.generic') : t(`ops.flags.errors.${error}`)}
        </p>
      ) : null}
      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      ) : res.data.items.length === 0 ? (
        <EmptyState title={t('ops.flags.empty')} />
      ) : (
        <ul className="divide-y rounded-md border" data-testid="feature-flags">
          {res.data.items.map((f) => (
            <li key={f.key} className="flex flex-col gap-3 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-mono font-medium">{f.key}</p>
                  {f.description ? <p className="text-xs text-muted-foreground">{f.description}</p> : null}
                </div>
                <p className="text-xs">
                  {t('ops.flags.default')}: <strong>{f.enabled ? t('ops.flags.on') : t('ops.flags.off')}</strong>
                  {' · '}
                  {t('ops.flags.enabledFor', { count: f.enabledFor.length })}
                  {' · '}
                  {t('ops.flags.disabledFor', { count: f.disabledFor.length })}
                </p>
              </div>
              {canSet ? (
                <div className="flex flex-wrap items-end gap-4">
                  <form action={setFeatureFlagAction}>
                    <input type="hidden" name="key" value={f.key} />
                    <input type="hidden" name="scope" value="default" />
                    <input type="hidden" name="value" value={f.enabled ? 'off' : 'on'} />
                    <Button type="submit" size="sm" variant="outline">
                      {f.enabled ? t('ops.flags.turnOff') : t('ops.flags.turnOn')}
                    </Button>
                  </form>
                  <form action={setFeatureFlagAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="key" value={f.key} />
                    <input type="hidden" name="scope" value="agency" />
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`agency-${f.key}`}>{t('ops.flags.agencyId')}</Label>
                      <Input id={`agency-${f.key}`} name="agencyId" required className="w-80" autoComplete="off" />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`value-${f.key}`}>{t('ops.flags.override')}</Label>
                      <select
                        id={`value-${f.key}`}
                        name="value"
                        className="h-9 rounded-md border bg-background px-2 text-sm"
                      >
                        <option value="on">{t('ops.flags.overrideOn')}</option>
                        <option value="off">{t('ops.flags.overrideOff')}</option>
                        <option value="clear">{t('ops.flags.overrideClear')}</option>
                      </select>
                    </div>
                    <Button type="submit" size="sm" variant="outline">
                      {t('ops.flags.apply')}
                    </Button>
                  </form>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
