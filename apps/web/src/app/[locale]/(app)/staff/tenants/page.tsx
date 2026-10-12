import { AgencyStatus } from '@inmolink/contracts';
import { Button, EmptyState, Input, Label } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { requireStaff } from '@/server/staff';
import { fetchTenants } from '@/server/staff-api';

const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;

/** Staff console: every agency, newest first (S1-09). Search by name or tax id, filter by status. */
export default async function TenantsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const { session } = await requireStaff();
  const params = await searchParams;
  const q = typeof params.q === 'string' && params.q.trim().length >= 2 ? params.q.trim().slice(0, 100) : undefined;
  const status = AgencyStatus.safeParse(params.status).data;
  const cursor = typeof params.cursor === 'string' && CURSOR.test(params.cursor) ? params.cursor : undefined;
  const res = await fetchTenants(session, { q, status, cursor });
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('staff');
  const format = await getFormatter();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">{t('tenants.title')}</h1>
      {params.notice === 'ended' ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {t('impersonation.endedNotice')}
        </p>
      ) : null}
      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="q">{t('tenants.search')}</Label>
          <Input id="q" name="q" defaultValue={q ?? ''} minLength={2} maxLength={100} className="w-64" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="status">{t('tenants.status')}</Label>
          <select
            id="status"
            name="status"
            defaultValue={status ?? ''}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            <option value="">{t('tenants.anyStatus')}</option>
            {AgencyStatus.options.map((s) => (
              <option key={s} value={s}>
                {t(`tenants.statuses.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="outline">
          {t('tenants.filter')}
        </Button>
      </form>
      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      ) : res.data.items.length === 0 ? (
        <EmptyState title={t('tenants.empty')} />
      ) : (
        <ul className="divide-y rounded-md border" data-testid="tenants">
          {res.data.items.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{a.name}</p>
                <p className="text-xs text-muted-foreground">
                  {t(`tenants.statuses.${a.status}`)} · {a.taxId ?? '—'} ·{' '}
                  {t('tenants.created', { date: format.dateTime(new Date(a.createdAt), { dateStyle: 'medium' }) })}
                </p>
              </div>
              <Link href={`/staff/tenants/${a.id}`} className="font-medium underline-offset-4 hover:underline">
                {t('tenants.open')}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {res.ok && res.data.nextCursor ? (
        <Link
          href={{
            pathname: '/staff/tenants',
            query: { ...(q ? { q } : {}), ...(status ? { status } : {}), cursor: res.data.nextCursor },
          }}
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('queue.next')}
        </Link>
      ) : null}
    </div>
  );
}
