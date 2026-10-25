import { AiSpendQuery } from '@inmolink/contracts';
import { Button, EmptyState, Input, Label } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { requireStaff } from '@/server/staff';
import { fetchAiSpend, fetchQueueHealth } from '@/server/staff-ops-api';

/**
 * Queue health and AI spend per tenant (S13-03, PLAN §7 M20): job counts per worker pool (and dead-lettered jobs), and
 * a month's AI spend per agency, highest first. Feed health stays on the import health page. Every staff role.
 */
export default async function StaffSystemPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const { session } = await requireStaff();
  const params = await searchParams;
  const q = AiSpendQuery.safeParse({ month: params.month || undefined });
  const month = q.success ? q.data.month : undefined;
  const [queues, spend] = await Promise.all([fetchQueueHealth(session), fetchAiSpend(session, month)]);
  if (queues === 'revoked' || spend === 'revoked') redirect('/session/expired');
  const t = await getTranslations('staff');
  const format = await getFormatter();
  const n = (v: number) => format.number(v);
  const usd = (micro: number) => format.number(micro / 1_000_000, { style: 'currency', currency: 'USD' });

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">{t('ops.system.title')}</h1>
      <Link href="/staff/imports" className="text-sm underline-offset-4 hover:underline">
        {t('ops.system.feedHealth')}
      </Link>

      <section aria-labelledby="queues" className="flex flex-col gap-3">
        <h2 id="queues" className="text-lg font-semibold">
          {t('ops.system.queuesTitle')}
        </h2>
        {!queues.ok || !queues.data.reachable ? (
          <p role="alert" className="text-sm text-destructive">
            {t('ops.system.unreachable')}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-left text-sm" data-testid="queue-health">
              <thead className="bg-muted">
                <tr>
                  <th className="p-2">{t('ops.system.pool')}</th>
                  <th className="p-2 text-right">{t('ops.system.waiting')}</th>
                  <th className="p-2 text-right">{t('ops.system.active')}</th>
                  <th className="p-2 text-right">{t('ops.system.delayed')}</th>
                  <th className="p-2 text-right">{t('ops.system.failed')}</th>
                  <th className="p-2 text-right">{t('ops.system.dead')}</th>
                </tr>
              </thead>
              <tbody className="divide-y tabular-nums">
                {queues.data.pools.map((p) => (
                  <tr key={p.pool}>
                    <td className="p-2 font-mono text-xs">{p.pool}</td>
                    <td className="p-2 text-right">{n(p.waiting)}</td>
                    <td className="p-2 text-right">{n(p.active)}</td>
                    <td className="p-2 text-right">{n(p.delayed)}</td>
                    <td className="p-2 text-right">{n(p.failed)}</td>
                    <td className={`p-2 text-right ${p.dead > 0 ? 'font-semibold text-destructive' : ''}`}>
                      {n(p.dead)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="ai-spend" className="flex flex-col gap-3">
        <h2 id="ai-spend" className="text-lg font-semibold">
          {t('ops.system.aiTitle')}
        </h2>
        <form className="flex items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="month">{t('ops.system.month')}</Label>
            <Input
              id="month"
              name="month"
              type="month"
              defaultValue={spend.ok ? spend.data.month : month}
              className="w-44"
            />
          </div>
          <Button type="submit" size="sm" variant="outline">
            {t('ops.system.show')}
          </Button>
        </form>
        {!spend.ok ? (
          <p role="alert" className="text-sm text-destructive">
            {t('errors.generic')}
          </p>
        ) : spend.data.items.length === 0 ? (
          <EmptyState title={t('ops.system.noSpend')} />
        ) : (
          <>
            <p className="text-sm">{t('ops.system.total', { amount: usd(spend.data.totalMicroUsd) })}</p>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-left text-sm" data-testid="ai-spend">
                <thead className="bg-muted">
                  <tr>
                    <th className="p-2">{t('ops.system.agency')}</th>
                    <th className="p-2 text-right">{t('ops.system.cost')}</th>
                    <th className="p-2 text-right">{t('ops.system.reserved')}</th>
                    <th className="p-2 text-right">{t('ops.system.calls')}</th>
                    <th className="p-2 text-right">{t('ops.system.tokens')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y tabular-nums">
                  {spend.data.items.map((r) => (
                    <tr key={r.agencyId}>
                      <td className="p-2">
                        {/* Agency data: rendered as text. */}
                        <Link href={`/staff/tenants/${r.agencyId}`} className="underline-offset-4 hover:underline">
                          {r.agencyName ?? t('ops.system.unknownAgency')}
                        </Link>
                      </td>
                      <td className="p-2 text-right">{usd(r.costMicroUsd)}</td>
                      <td className="p-2 text-right">{usd(r.reservedMicroUsd)}</td>
                      <td className="p-2 text-right">{n(r.calls)}</td>
                      <td className="p-2 text-right">
                        {n(r.inputTokens)} / {n(r.outputTokens)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
