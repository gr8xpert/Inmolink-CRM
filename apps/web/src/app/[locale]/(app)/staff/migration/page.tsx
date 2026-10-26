import { MIGRATION_VALIDATION_MAX_UNEXPLAINED_RATE, MigrationValidationStatus } from '@inmolink/contracts';
import { EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { requireStaff } from '@/server/staff';
import { fetchValidationReports } from '@/server/staff-migration-api';
import { StatusBadge } from './status-badge';

/**
 * Legacy migration validation (S14-03, PLAN §14 step 6): each legacy agency's latest report, PASS or FAIL against the
 * < 0.5 % target, with a drill-down per agency. Every staff role may look; the reports come from `pnpm legacy:validate`.
 */
export default async function StaffMigrationPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const { session } = await requireStaff();
  const params = await searchParams;
  const status = MigrationValidationStatus.safeParse(params.status);
  const res = await fetchValidationReports(session, {
    status: status.success ? status.data : undefined,
    cursor: params.cursor,
  });
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('staff');
  const format = await getFormatter();
  const percent = (n: number) => format.number(n, { style: 'percent', maximumFractionDigits: 2 });
  const filters = [undefined, ...MigrationValidationStatus.options];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t('migration.title')}</h1>
        <nav aria-label={t('migration.filter')} className="flex gap-3 text-sm">
          {filters.map((s) => {
            const current = (status.success ? status.data : undefined) === s;
            return (
              <Link
                key={s ?? 'all'}
                href={{ pathname: '/staff/migration', query: s ? { status: s } : {} }}
                aria-current={current ? 'page' : undefined}
                className={current ? 'font-semibold underline' : 'underline-offset-4 hover:underline'}
              >
                {s ? t(`migration.status.${s}`) : t('migration.all')}
              </Link>
            );
          })}
        </nav>
      </div>
      <p className="text-sm text-muted-foreground">
        {t('migration.intro', { target: percent(MIGRATION_VALIDATION_MAX_UNEXPLAINED_RATE) })}
      </p>
      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      ) : res.data.items.length === 0 ? (
        <EmptyState title={t('migration.empty')} />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm" data-testid="migration-validations">
            <thead className="bg-muted text-left text-xs">
              <tr>
                <th className="p-2">{t('migration.legacyAgency')}</th>
                <th className="p-2">{t('migration.result')}</th>
                <th className="p-2 text-right">{t('migration.unexplainedRate')}</th>
                <th className="p-2 text-right">{t('migration.sampleDiffs')}</th>
                <th className="p-2 text-right">{t('migration.urlFailures')}</th>
                <th className="p-2">{t('migration.validatedAt')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {res.data.items.map((r) => (
                <tr key={r.id}>
                  <td className="p-2">
                    <Link href={`/staff/migration/${r.id}`} className="font-medium underline-offset-4 hover:underline">
                      {r.legacyAgencyId}
                    </Link>
                  </td>
                  <td className="p-2">
                    <StatusBadge status={r.status} label={t(`migration.status.${r.status}`)} />
                  </td>
                  <td className="p-2 text-right tabular-nums">
                    {percent(r.rate)}{' '}
                    <span className="text-xs text-muted-foreground">
                      ({t('migration.ofRows', { unexplained: r.unexplained, legacy: r.legacyRows })})
                    </span>
                  </td>
                  <td className="p-2 text-right tabular-nums">{r.sampleDiffs}</td>
                  <td className="p-2 text-right tabular-nums">{r.urlFailures}</td>
                  <td className="p-2 text-xs text-muted-foreground">
                    {format.dateTime(new Date(r.createdAt), { dateStyle: 'short', timeStyle: 'short' })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {res.ok && res.data.nextCursor ? (
        <Link
          href={{
            pathname: '/staff/migration',
            query: { cursor: res.data.nextCursor, ...(status.success ? { status: status.data } : {}) },
          }}
          className="text-sm underline-offset-4 hover:underline"
        >
          {t('queue.next')}
        </Link>
      ) : null}
    </div>
  );
}
