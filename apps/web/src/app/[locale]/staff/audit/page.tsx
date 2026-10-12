import { AuditTypeFilter } from '@inmolink/contracts';
import { Button, Input, Label } from '@inmolink/ui';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { Link } from '@/i18n/navigation';
import { requireStaff } from '@/server/staff';
import { fetchStaffAuditLog } from '@/server/staff-api';

const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` from a date input → the UTC midnight starting that day (`to` is exclusive: the next day's). */
function dayStart(v: string | undefined, plusDays = 0): string | undefined {
  if (!v || !DAY.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  d.setUTCDate(d.getUTCDate() + plusDays);
  return d.toISOString();
}

/**
 * Staff audit viewer (S1-09): every agency's log, or one agency's, by type and day range, newest first.
 * Each page served is itself audited (`staff.auditLog.read`). Super admins and support only.
 */
export default async function StaffAuditPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const { session, me } = await requireStaff();
  if (me.role === 'STAFF_DATA_OPS') notFound();
  const params = await searchParams;
  const agencyId = z.uuid().safeParse(params.agencyId).data;
  const type = AuditTypeFilter.safeParse(params.type).data;
  const fromDay = typeof params.from === 'string' && DAY.test(params.from) ? params.from : undefined;
  const toDay = typeof params.to === 'string' && DAY.test(params.to) ? params.to : undefined;
  const cursor = typeof params.cursor === 'string' && CURSOR.test(params.cursor) ? params.cursor : undefined;
  const res = await fetchStaffAuditLog(session, {
    agencyId,
    type,
    from: dayStart(fromDay),
    to: dayStart(toDay, 1),
    cursor,
  });
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('staff');
  const format = await getFormatter();
  const filters = {
    ...(agencyId ? { agencyId } : {}),
    ...(type ? { type } : {}),
    ...(fromDay ? { from: fromDay } : {}),
    ...(toDay ? { to: toDay } : {}),
  };

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">{t('audit.title')}</h1>
      <p className="text-xs text-muted-foreground">{t('audit.audited')}</p>
      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="agencyId">{t('audit.agency')}</Label>
          <Input id="agencyId" name="agencyId" defaultValue={agencyId ?? ''} className="w-80 font-mono text-xs" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="type">{t('audit.type')}</Label>
          <Input id="type" name="type" defaultValue={type ?? ''} placeholder="identity.login.failed" className="w-60" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="from">{t('audit.from')}</Label>
          <Input id="from" name="from" type="date" defaultValue={fromDay ?? ''} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="to">{t('audit.to')}</Label>
          <Input id="to" name="to" type="date" defaultValue={toDay ?? ''} />
        </div>
        <Button type="submit" variant="outline">
          {t('tenants.filter')}
        </Button>
      </form>
      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {res.error?.code === 'VALIDATION_FAILED' ? t('audit.badRange') : t('errors.generic')}
        </p>
      ) : res.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('audit.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-xs" data-testid="staff-audit">
            <thead className="bg-muted">
              <tr>
                <th className="p-2">{t('audit.when')}</th>
                <th className="p-2">{t('audit.type')}</th>
                <th className="p-2">{t('audit.agency')}</th>
                <th className="p-2">{t('audit.actor')}</th>
                <th className="p-2">{t('audit.target')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {res.data.items.map((e) => (
                <tr key={e.id}>
                  <td className="p-2 whitespace-nowrap">
                    {format.dateTime(new Date(e.occurredAt), { dateStyle: 'short', timeStyle: 'medium' })}
                  </td>
                  <td className="p-2 font-mono">{e.type}</td>
                  <td className="p-2 font-mono">
                    <Link href={`/staff/tenants/${e.agencyId}`} className="underline-offset-4 hover:underline">
                      {e.agencyId.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="p-2 font-mono">
                    {e.actor.kind}
                    {e.actor.userId ? ` ${e.actor.userId.slice(0, 8)}` : ''}
                    {e.actor.impersonatedBy ? ` ${t('audit.via', { staff: e.actor.impersonatedBy.slice(0, 8) })}` : ''}
                  </td>
                  <td className="p-2 font-mono">{e.target ? `${e.target.type} ${e.target.id.slice(0, 8)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {res.ok && res.data.nextCursor ? (
        <Link
          href={{ pathname: '/staff/audit', query: { ...filters, cursor: res.data.nextCursor } }}
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('queue.next')}
        </Link>
      ) : null}
    </main>
  );
}
