import { LEAD_SOURCES, LEAD_STATUSES, type LeadSource, type LeadStatus } from '@inmolink/contracts';
import { EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchLeads } from '@/server/contacts-api';
import { contactName } from '../contacts/lookup';

const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;

/**
 * Lead inbox (S11-F14, PLAN §7 M8): website, portal, chatbot, WhatsApp and manual leads in one list, newest first, with
 * status, source and assignment filters. Server-rendered; the API decides what the member sees.
 */
export default async function InboxPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const params = await searchParams;
  const status = (LEAD_STATUSES as readonly string[]).includes(params.status ?? '')
    ? (params.status as LeadStatus)
    : undefined;
  const source = (LEAD_SOURCES as readonly string[]).includes(params.source ?? '')
    ? (params.source as LeadSource)
    : undefined;
  const assigned = params.assigned === 'me' || params.assigned === 'unassigned' ? params.assigned : undefined;
  const cursor = typeof params.cursor === 'string' && CURSOR.test(params.cursor) ? params.cursor : undefined;
  const t = await getTranslations('leads.inbox');
  const format = await getFormatter();
  const res = await fetchLeads(sessionRef(session.user), { status, source, assigned, cursor });
  if (res === 'revoked') redirect('/session/expired');

  return (
    <div className="flex flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>

      <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span>{t('fields.status')}</span>
          <select name="status" defaultValue={status ?? ''} className="h-9 rounded-md border bg-background px-2">
            <option value="">{t('anyStatus')}</option>
            {LEAD_STATUSES.map((v) => (
              <option key={v} value={v}>
                {t(`statuses.${v}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{t('fields.source')}</span>
          <select name="source" defaultValue={source ?? ''} className="h-9 rounded-md border bg-background px-2">
            <option value="">{t('anySource')}</option>
            {LEAD_SOURCES.map((v) => (
              <option key={v} value={v}>
                {t(`sources.${v}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{t('fields.assignedTo')}</span>
          <select name="assigned" defaultValue={assigned ?? ''} className="h-9 rounded-md border bg-background px-2">
            <option value="">{t('anyone')}</option>
            <option value="me">{t('mine')}</option>
            <option value="unassigned">{t('unassigned')}</option>
          </select>
        </label>
        <button type="submit" className="h-9 rounded-md border px-3 font-medium">
          {t('filter')}
        </button>
      </form>

      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t('load')}
        </p>
      ) : res.data.items.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <ul className="divide-y rounded-md border" data-testid="lead-list">
          {res.data.items.map((lead) => (
            <li key={lead.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
              <div className="flex min-w-60 flex-1 flex-col">
                <Link href={`/inbox/${lead.id}`} className="font-medium underline-offset-4 hover:underline">
                  {contactName(lead.contact) ?? t('noClient')}
                </Link>
                <span className="text-muted-foreground">
                  {[
                    t(`sources.${lead.source}`),
                    t(`kinds.${lead.kind}`),
                    lead.target?.shownRef ? `${t('fields.target')}: ${lead.target.shownRef}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
              <span className="rounded-md border px-2 py-0.5 text-xs">{t(`statuses.${lead.status}`)}</span>
              <span className="text-muted-foreground">
                {format.dateTime(new Date(lead.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {res.ok && res.data.nextCursor ? (
        <Link
          href={{
            pathname: '/inbox',
            query: {
              ...(status ? { status } : {}),
              ...(source ? { source } : {}),
              ...(assigned ? { assigned } : {}),
              cursor: res.data.nextCursor,
            },
          }}
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('loadMore')}
        </Link>
      ) : null}
    </div>
  );
}
