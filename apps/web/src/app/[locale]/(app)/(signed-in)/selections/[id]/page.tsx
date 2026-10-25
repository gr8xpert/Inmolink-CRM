import { Button } from '@inmolink/ui';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { agencyTimeZone } from '@/server/agency-time-zone';
import { sessionRef } from '@/server/api';
import { fetchSelection, fetchSelectionInteractions } from '@/server/selections-api';
import { revokeSelectionAction, rotateLinkAction } from '../actions';
import { SELECTION_DONE, SELECTION_ERRORS } from '../errors';
import { errorLabels, shareLabels } from '../labels';
import { ShareForm } from '../share-form';

/**
 * One selection (S13-F13): its status, the client's views, likes and enquiries (totals, per item and the latest
 * interactions), a new link (the old one stops working; shown once with the WhatsApp and e-mail buttons) and revoke.
 */
export default async function SelectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const query = await searchParams;
  const ref = sessionRef(session.user);
  const [selection, interactions] = await Promise.all([fetchSelection(ref, id), fetchSelectionInteractions(ref, id)]);
  if (selection === 'revoked' || interactions === 'revoked') redirect('/session/expired');
  if (!selection.ok && selection.status === 404) notFound();
  const t = await getTranslations('selections');
  const tt = t as unknown as (key: string) => string;
  const format = await getFormatter();
  const timeZone = await agencyTimeZone(ref);
  const when = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short', timeZone }) : '—';
  const done = SELECTION_DONE.find((d) => d === query.done);
  const failed = SELECTION_ERRORS.find((c) => c === query.error);

  if (!selection.ok) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      </div>
    );
  }
  const s = selection.data;
  const likes = s.items.reduce((n, i) => n + i.likes, 0);
  const enquiries = s.items.reduce((n, i) => n + i.enquiries, 0);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <div>
        <Link href="/selections" className="text-sm underline-offset-4 hover:underline">
          {t('back')}
        </Link>
        <h1 className="mt-1 text-xl font-semibold">{s.title}</h1>
        <p className="text-sm text-muted-foreground">
          {t(`statuses.${s.status}`)} · {t('detail.expires', { when: when(s.expiresAt) })} ·{' '}
          {t('detail.tokenHint', { hint: s.tokenHint })}
        </p>
      </div>
      {done ? (
        <p role="status" className="rounded-md border bg-muted p-3 text-sm">
          {t(`notices.${done}`)}
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${failed}`)}
        </p>
      ) : null}

      <dl className="grid grid-cols-3 gap-3" data-testid="selection-stats">
        <div className="rounded-md border p-3">
          <dt className="text-xs text-muted-foreground">{t('stats.views')}</dt>
          <dd className="text-lg font-semibold" data-testid="stat-views">
            {format.number(s.stats.views)}
          </dd>
          <dd className="text-xs text-muted-foreground">{when(s.stats.lastViewedAt)}</dd>
        </div>
        <div className="rounded-md border p-3">
          <dt className="text-xs text-muted-foreground">{t('stats.likes')}</dt>
          <dd className="text-lg font-semibold" data-testid="stat-likes">
            {format.number(likes)}
          </dd>
        </div>
        <div className="rounded-md border p-3">
          <dt className="text-xs text-muted-foreground">{t('stats.enquiries')}</dt>
          <dd className="text-lg font-semibold" data-testid="stat-enquiries">
            {format.number(enquiries)}
          </dd>
        </div>
      </dl>

      <section aria-labelledby="sel-items" className="flex flex-col gap-2">
        <h2 id="sel-items" className="font-medium">
          {t('detail.items')}
        </h2>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="p-2">{t('detail.item')}</th>
                <th className="p-2">{t('stats.likes')}</th>
                <th className="p-2">{t('stats.enquiries')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {s.items.map((i) => (
                <tr key={i.targetId}>
                  <td className="p-2">
                    {i.titleOverride ?? <span className="font-mono text-xs">{i.targetId}</span>}
                    {i.note ? <span className="block text-xs text-muted-foreground">{i.note}</span> : null}
                  </td>
                  <td className="p-2">{format.number(i.likes)}</td>
                  <td className="p-2">{format.number(i.enquiries)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="sel-activity" className="flex flex-col gap-2">
        <h2 id="sel-activity" className="font-medium">
          {t('detail.activity')}
        </h2>
        {!interactions.ok ? (
          <p role="alert" className="text-sm text-destructive">
            {t('errors.generic')}
          </p>
        ) : interactions.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('detail.noActivity')}</p>
        ) : (
          <ul className="divide-y rounded-md border text-sm" data-testid="selection-activity">
            {interactions.data.items.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-2 p-2">
                <span className="font-medium">{t(`kinds.${a.kind}`)}</span>
                {a.message ? <span>{a.message}</span> : null}
                <span className="ml-auto text-muted-foreground">{when(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {s.status === 'LIVE' ? (
        <section aria-labelledby="sel-manage" className="flex flex-col gap-3">
          <h2 id="sel-manage" className="font-medium">
            {t('detail.manage')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('detail.rotateHint')}</p>
          <ShareForm
            action={rotateLinkAction}
            submit={t('detail.rotate')}
            errors={errorLabels(tt)}
            share={shareLabels(tt)}
            openLabel={t('create.open')}
          >
            <input type="hidden" name="selectionId" value={s.id} />
            <input type="hidden" name="version" value={s.version} />
          </ShareForm>
          <form action={revokeSelectionAction}>
            <input type="hidden" name="selectionId" value={s.id} />
            <input type="hidden" name="version" value={s.version} />
            <Button type="submit" variant="outline" size="sm">
              {t('detail.revoke')}
            </Button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
