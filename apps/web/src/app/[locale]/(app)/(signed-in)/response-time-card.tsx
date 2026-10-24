import type { ResponseTimeKpiDto } from '@inmolink/contracts';
import { getTranslations } from 'next-intl/server';
import { durationParts } from './response-time';

/** The response-time KPI card of the dashboard home (S10-09): the agency's median first response and each member's. */
export async function ResponseTimeCard({ kpi }: { kpi: ResponseTimeKpiDto }) {
  const t = await getTranslations('auth');
  const show = (seconds: number) => {
    const p = durationParts(seconds);
    if (p.unit === 'seconds') return t('home.kpiSeconds', { value: p.value });
    if (p.unit === 'minutes') return t('home.kpiMinutes', { value: p.value });
    return t('home.kpiHours', { hours: p.hours, minutes: p.minutes });
  };
  return (
    <section
      data-testid="response-time-kpi"
      aria-labelledby="response-time-title"
      className="flex flex-col gap-2 rounded-md border p-3 text-sm"
    >
      <h2 id="response-time-title" className="font-medium">
        {t('home.kpiTitle')}
      </h2>
      {kpi.medianSeconds === null ? (
        <p>{t('home.kpiNone')}</p>
      ) : (
        <>
          <p>
            {t('home.kpiMedian')}: <strong data-testid="response-time-median">{show(kpi.medianSeconds)}</strong>
          </p>
          <p className="text-muted-foreground">{t('home.kpiLeads', { responded: kpi.responded, leads: kpi.leads })}</p>
          {kpi.agents.length > 0 ? (
            <div>
              <h3 className="font-medium">{t('home.kpiAgents')}</h3>
              <ul className="list-disc pl-5">
                {kpi.agents.slice(0, 5).map((a) => (
                  <li key={a.userId}>
                    {a.name ?? t('home.kpiUnknownAgent')}: {a.medianSeconds === null ? '–' : show(a.medianSeconds)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
