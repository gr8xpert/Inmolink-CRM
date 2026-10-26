import { MIGRATION_VALIDATION_MAX_UNEXPLAINED_RATE, MigrationValidationParams } from '@inmolink/contracts';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import { requireStaff } from '@/server/staff';
import { fetchValidationReport } from '@/server/staff-migration-api';
import { StatusBadge } from '../status-badge';

const ENTITIES = ['user', 'listing', 'development', 'unit', 'contact', 'lead'] as const;
const entityKey = (e: string) =>
  (ENTITIES as readonly string[]).includes(e) ? (e as (typeof ENTITIES)[number]) : null;

/**
 * One legacy agency's validation report (S14-03): counts per entity, images, the sampled rows that differ (field names
 * only, never values) and the URL checks of the sampled listings. Every staff role may look.
 */
export default async function StaffMigrationReportPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { session } = await requireStaff();
  const parsed = MigrationValidationParams.safeParse({ id: (await params).id });
  if (!parsed.success) notFound();
  const res = await fetchValidationReport(session, parsed.data.id);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok && res.status === 404) notFound();
  const t = await getTranslations('staff');
  const format = await getFormatter();
  const percent = (n: number) => format.number(n, { style: 'percent', maximumFractionDigits: 2 });
  if (!res.ok) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('errors.generic')}
      </p>
    );
  }
  const { report } = res.data;
  const name = (e: string) => {
    const k = entityKey(e);
    return k ? t(`migration.entities.${k}`) : e;
  };
  const dash = (n: number | null) => (n === null ? '—' : n);
  const differing = report.sample.samples.filter((s) => s.outcome !== 'MATCH' || s.explainedFields.length > 0);

  return (
    <div className="flex flex-col gap-6">
      <Link href="/staff/migration" className="text-sm underline-offset-4 hover:underline">
        {t('migration.back')}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{t('migration.reportTitle', { id: res.data.legacyAgencyId })}</h1>
        <StatusBadge status={res.data.status} label={t(`migration.status.${res.data.status}`)} />
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <Item label={t('migration.agency')}>
          <Link href={`/staff/tenants/${res.data.agencyId}`} className="underline-offset-4 hover:underline">
            {res.data.agencyId}
          </Link>
        </Item>
        <Item label={t('migration.validatedAt')}>
          {format.dateTime(new Date(res.data.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
        </Item>
        <Item label={t('migration.unexplainedRate')}>
          {percent(report.totals.rate)} (
          {t('migration.ofRows', {
            unexplained: report.totals.unexplained,
            legacy: report.totals.legacy,
          })}
          )
        </Item>
        <Item label={t('migration.target')}>{percent(MIGRATION_VALIDATION_MAX_UNEXPLAINED_RATE)}</Item>
        <Item label={t('migration.sampleRate')}>
          {percent(report.sample.rate)} (
          {t('migration.sampleOf', {
            differing: report.sample.differing,
            rows: report.sample.rows,
          })}
          )
        </Item>
        <Item label={t('migration.urlRate')}>
          {percent(report.urls.rate)} (
          {t('migration.urlOf', { failed: report.urls.failed, checked: report.urls.checked })})
        </Item>
      </dl>

      {report.failedBatches.length > 0 ? (
        <section aria-labelledby="mv-failed" className="flex flex-col gap-2 rounded-md border border-destructive p-3">
          <h2 id="mv-failed" className="font-medium text-destructive">
            {t('migration.failedBatches')}
          </h2>
          <ul className="text-sm">
            {report.failedBatches.map((b) => (
              <li key={`${b.entity}-${b.seq}`}>
                {b.entity} #{b.seq}: <code className="text-xs">{b.error ?? '—'}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="mv-counts" className="flex flex-col gap-2">
        <h2 id="mv-counts" className="text-lg font-semibold">
          {t('migration.counts')}
        </h2>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs">
              <tr>
                <th className="p-2">{t('migration.entity')}</th>
                <th className="p-2 text-right">{t('migration.legacy')}</th>
                <th className="p-2 text-right">{t('migration.staged')}</th>
                <th className="p-2 text-right">{t('migration.mapped')}</th>
                <th className="p-2 text-right">{t('migration.explained')}</th>
                <th className="p-2 text-right">{t('migration.unexplained')}</th>
                <th className="p-2">{t('migration.issues')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {report.counts.map((c) => (
                <tr key={c.entity} className={c.unexplained > 0 ? 'bg-red-50 dark:bg-red-950' : undefined}>
                  <td className="p-2 font-medium">{name(c.entity)}</td>
                  <td className="p-2 text-right tabular-nums">{dash(c.legacyRows)}</td>
                  <td className="p-2 text-right tabular-nums">{c.staged}</td>
                  <td className="p-2 text-right tabular-nums">{c.mapped}</td>
                  <td className="p-2 text-right tabular-nums">{c.explained}</td>
                  <td className="p-2 text-right tabular-nums">{c.unexplained}</td>
                  <td className="p-2 text-xs text-muted-foreground">
                    {Object.entries(c.issuesByReason)
                      .map(([reason, n]) => `${reason} ${n}`)
                      .join(' · ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="mv-images" className="flex flex-col gap-2">
        <h2 id="mv-images" className="text-lg font-semibold">
          {t('migration.images')}
        </h2>
        <dl className="grid gap-2 text-sm sm:grid-cols-3">
          <Item label={t('migration.legacy')}>{dash(report.images.legacy)}</Item>
          <Item label={t('migration.staged')}>{report.images.staged}</Item>
          <Item label={t('migration.imagesExpected')}>{report.images.expected}</Item>
          <Item label={t('migration.imagesAttached')}>{report.images.attached}</Item>
          <Item label={t('migration.imagesPending')}>{report.images.pending}</Item>
          <Item label={t('migration.unexplained')}>{report.images.unexplained}</Item>
        </dl>
      </section>

      <section aria-labelledby="mv-sample" className="flex flex-col gap-2">
        <h2 id="mv-sample" className="text-lg font-semibold">
          {t('migration.sample')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('migration.sampleIntro', { size: report.sample.size })}</p>
        {report.sample.fields.length > 0 ? (
          <ul className="text-sm">
            {report.sample.fields.map((f) => (
              <li key={`${f.entity}-${f.field}`}>
                {name(f.entity)} · <code className="text-xs">{f.field}</code>:{' '}
                {t('migration.fieldOf', { differing: f.differing, compared: f.compared })}
              </li>
            ))}
          </ul>
        ) : null}
        {differing.length === 0 ? (
          <p className="text-sm">{t('migration.sampleClean')}</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="migration-sample-diffs">
              <thead className="bg-muted text-left text-xs">
                <tr>
                  <th className="p-2">{t('migration.entity')}</th>
                  <th className="p-2">{t('migration.legacyId')}</th>
                  <th className="p-2">{t('migration.outcome')}</th>
                  <th className="p-2">{t('migration.fields')}</th>
                  <th className="p-2">{t('migration.explainedFields')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {differing.map((s) => (
                  <tr key={`${s.entity}-${s.legacyId}`}>
                    <td className="p-2">{name(s.entity)}</td>
                    <td className="p-2 font-mono text-xs">{s.legacyId}</td>
                    <td className="p-2">{t(`migration.outcomes.${s.outcome}`)}</td>
                    <td className="p-2 font-mono text-xs">{s.fields.join(', ') || '—'}</td>
                    <td className="p-2 font-mono text-xs text-muted-foreground">
                      {s.explainedFields.join(', ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="mv-urls" className="flex flex-col gap-2">
        <h2 id="mv-urls" className="text-lg font-semibold">
          {t('migration.urls')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('migration.urlsIntro')}</p>
        {report.urls.checks.length === 0 ? (
          <p className="text-sm">{t('migration.noUrls')}</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left text-xs">
                <tr>
                  <th className="p-2">{t('migration.legacyId')}</th>
                  <th className="p-2">{t('migration.lookup')}</th>
                  <th className="p-2">{t('migration.images')}</th>
                  <th className="p-2">{t('migration.result')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {report.urls.checks.map((c) => (
                  <tr key={c.legacyId} className={c.pass ? undefined : 'bg-red-50 dark:bg-red-950'}>
                    <td className="p-2 font-mono text-xs">{c.legacyId}</td>
                    <td className="p-2">{t(`migration.lookups.${c.lookup}`)}</td>
                    <td className="p-2 tabular-nums">
                      {t('migration.imageCheck', {
                        attached: c.images.attached,
                        pending: c.images.pending,
                        checked: c.images.checked,
                      })}
                    </td>
                    <td className="p-2">
                      <StatusBadge
                        status={c.pass ? 'PASS' : 'FAIL'}
                        label={t(`migration.status.${c.pass ? 'PASS' : 'FAIL'}`)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
