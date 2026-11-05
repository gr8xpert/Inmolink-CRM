import { notFound, redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { ClientModeUnavailable } from '@/components/shell/client-mode-unavailable';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchLead } from '@/server/contacts-api';
import { inClientMode } from '@/server/nav';
import { loadShell } from '@/server/shell';
import { contactName } from '../../contacts/lookup';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One lead (S11-F14): who, what for, the message and the details the visitor typed (never rewritten into the contact). */
export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const clientShell = await loadShell();
  if (clientShell && inClientMode(clientShell.identity)) return <ClientModeUnavailable />;
  const { id } = await params;
  if (!UUID.test(id)) return localeRedirect({ href: '/inbox', locale });
  const t = await getTranslations('leads.inbox');
  const format = await getFormatter();
  const res = await fetchLead(sessionRef(session.user), id);
  if (res === 'revoked') redirect('/session/expired');
  const back = (
    <Link href="/inbox" className="text-sm underline-offset-4 hover:underline">
      {t('back')}
    </Link>
  );
  // S17-F40: an unknown or foreign lead is the same "Page not found" as any other unknown page.
  if (!res.ok && res.status === 404) notFound();
  if (!res.ok) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
        {back}
        <p role="alert" className="text-sm text-destructive">
          {t('load')}
        </p>
      </div>
    );
  }
  const lead = res.data;
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const rows: Array<[string, string]> = [
    [t('fields.source'), t(`sources.${lead.source}`)],
    [t('fields.status'), t(`statuses.${lead.status}`)],
    [t('fields.receivedAt'), when(lead.createdAt)],
    [t('detail.firstResponse'), lead.firstRespondedAt ? when(lead.firstRespondedAt) : t('detail.notYet')],
  ];
  if (lead.target?.shownRef) rows.push([t('fields.target'), lead.target.shownRef]);
  // S17-F49: a viewing request's preferred slots, like the notification e-mail ("2026-11-20 (morning), ...").
  if (lead.viewingSlots?.length) {
    rows.push([
      t('detail.slots'),
      lead.viewingSlots.map((s) => `${s.date} (${t(`detail.timeOfDay.${s.timeOfDay}`)})`).join(', '),
    ]);
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{contactName(lead.contact) ?? t('noClient')}</h1>
        {back}
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {lead.message ? (
        <section aria-labelledby="message" className="flex flex-col gap-1 text-sm">
          <h2 id="message" className="text-base font-semibold">
            {t('fields.message')}
          </h2>
          <p className="whitespace-pre-wrap rounded-md border p-3">{lead.message}</p>
        </section>
      ) : null}
      {lead.visitor ? (
        <section aria-labelledby="visitor" className="flex flex-col gap-1 text-sm">
          <h2 id="visitor" className="text-base font-semibold">
            {t('detail.visitor')}
          </h2>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">{t('detail.name')}</dt>
            <dd>{lead.visitor.name ?? ''}</dd>
            <dt className="text-muted-foreground">{t('detail.email')}</dt>
            <dd>{lead.visitor.email ?? ''}</dd>
            <dt className="text-muted-foreground">{t('detail.phone')}</dt>
            <dd>{lead.visitor.phone ?? ''}</dd>
            <dt className="text-muted-foreground">{t('detail.marketing')}</dt>
            <dd>{lead.visitor.marketingConsent ? t('detail.yes') : t('detail.no')}</dd>
          </dl>
        </section>
      ) : null}
      <Link href={`/contacts/${lead.contact.id}`} className="text-sm font-medium underline-offset-4 hover:underline">
        {t('detail.contact')}
      </Link>
    </div>
  );
}
