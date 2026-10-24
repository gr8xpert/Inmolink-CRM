import {
  REGISTRATION_TARGET_KINDS,
  type ReceivedRegistrationDto,
  type RegistrationDto,
  type RegistrationTargetKind,
  VIEWING_STATUSES,
  type ViewingRequestDto,
  type ViewingStatus,
} from '@inmolink/contracts';
import { EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import {
  fetchOwnRegistrations,
  fetchOwnViewings,
  fetchReceivedRegistrations,
  fetchReceivedViewings,
} from '@/server/collaborations-api';
import { parseCollaborationParams, type SectionKey, sectionsFor } from './filters';

/**
 * My collaborations (S11-06, PLAN §7 M10): the agency's client registrations and viewing requests, introduced by it (out)
 * and received for its own listings and developments (in), with state, direction, type, target and date filters.
 * Server-rendered. Unfiltered it shows the first rows of each of the four lists (a handful of queries in all); a chosen
 * direction and type is one list, paged by cursor. The owner's side never shows the client (the API strips it).
 */
export default async function CollaborationsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const f = parseCollaborationParams(await searchParams);
  const t = await getTranslations('network.collaborations');
  const format = await getFormatter();
  const ref = sessionRef(session.user);
  const sections = sectionsFor(f);
  const single = sections.length === 1;
  const base = { limit: single ? 25 : 10, cursor: single ? f.cursor : undefined, kind: f.kind, from: f.from, to: f.to };
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });
  const dateTime = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const target = (k: RegistrationTargetKind, id: string) => `${t(`kinds.${k}`)} ${id.slice(0, 8)}`;

  const results = await Promise.all(
    sections.map(async (key) => {
      switch (key) {
        case 'outRegistrations':
          return [key, await fetchOwnRegistrations(ref, { ...base, state: f.regState })] as const;
        case 'inRegistrations':
          return [key, await fetchReceivedRegistrations(ref, { ...base, state: f.regState })] as const;
        case 'outViewings':
          return [key, await fetchOwnViewings(ref, { ...base, status: f.viewStatus })] as const;
        case 'inViewings':
          return [key, await fetchReceivedViewings(ref, { ...base, status: f.viewStatus })] as const;
      }
    }),
  );
  if (results.some(([, r]) => r === 'revoked')) redirect('/session/expired');

  const select = 'h-9 rounded-md border bg-background px-2';
  const moreQuery = (key: SectionKey, cursor: string) => ({
    ...(f.direction ? { direction: f.direction } : { direction: key.startsWith('out') ? 'OUT' : 'IN' }),
    type: key.endsWith('Registrations') ? 'REGISTRATION' : 'VIEWING',
    ...(f.state ? { state: f.state } : {}),
    ...(f.kind ? { kind: f.kind } : {}),
    ...(f.from ? { from: f.from } : {}),
    ...(f.to ? { to: f.to } : {}),
    cursor,
  });

  return (
    <div className="flex flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>

      <form method="get" aria-label={t('filters.label')} className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span>{t('filters.direction')}</span>
          <select name="direction" defaultValue={f.direction ?? ''} className={select}>
            <option value="">{t('any')}</option>
            <option value="OUT">{t('directions.OUT')}</option>
            <option value="IN">{t('directions.IN')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{t('filters.type')}</span>
          <select name="type" defaultValue={f.type ?? ''} className={select}>
            <option value="">{t('any')}</option>
            <option value="REGISTRATION">{t('types.REGISTRATION')}</option>
            <option value="VIEWING">{t('types.VIEWING')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{t('filters.state')}</span>
          <select name="state" defaultValue={f.state ?? ''} className={select}>
            <option value="">{t('any')}</option>
            <option value="ACTIVE">{t('registrationStates.ACTIVE')}</option>
            {VIEWING_STATUSES.map((v) => (
              <option key={v} value={v}>
                {t(`viewingStates.${v}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{t('filters.kind')}</span>
          <select name="kind" defaultValue={f.kind ?? ''} className={select}>
            <option value="">{t('any')}</option>
            {REGISTRATION_TARGET_KINDS.map((v) => (
              <option key={v} value={v}>
                {t(`kinds.${v}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{t('filters.from')}</span>
          <input type="date" name="from" defaultValue={f.from ?? ''} className={select} />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t('filters.to')}</span>
          <input type="date" name="to" defaultValue={f.to ?? ''} className={select} />
        </label>
        <button type="submit" className="h-9 rounded-md border px-3 font-medium">
          {t('filters.apply')}
        </button>
        <Link
          href="/collaborations"
          className="h-9 content-center text-muted-foreground underline-offset-4 hover:underline"
        >
          {t('filters.reset')}
        </Link>
      </form>

      {sections.length === 0 ? <EmptyState title={t('empty')} /> : null}

      {results.map(([key, res]) => (
        <section key={key} aria-labelledby={`h-${key}`} className="flex flex-col gap-2" data-testid={`section-${key}`}>
          <h2 id={`h-${key}`} className="text-base font-semibold">
            {t(`sections.${key}`)}
          </h2>
          {res === 'revoked' ? null : !res.ok ? (
            <p role="alert" className="text-sm text-destructive">
              {t('load')}
            </p>
          ) : res.data.items.length === 0 ? (
            <EmptyState title={t('empty')} />
          ) : (
            <ul className="divide-y rounded-md border">
              {key === 'outRegistrations'
                ? (res.data.items as RegistrationDto[]).map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                      <div className="flex min-w-60 flex-1 flex-col">
                        <span className="font-medium">
                          {[r.client.firstName, r.client.lastName].filter(Boolean).join(' ') || t('row.noClient')}
                        </span>
                        <span className="text-muted-foreground">{target(r.target.kind, r.target.id)}</span>
                      </div>
                      <StateBadge label={t(`registrationStates.${r.state}`)} />
                      <span className="text-muted-foreground">
                        {t('row.registered')}: {date(r.registeredAt)} · {t('row.validUntil')}: {date(r.expiresAt)}
                      </span>
                    </li>
                  ))
                : null}
              {key === 'inRegistrations'
                ? (res.data.items as ReceivedRegistrationDto[]).map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                      <div className="flex min-w-60 flex-1 flex-col">
                        <span className="font-medium">
                          {t('row.introducedBy')}: {r.introducerName ?? t('row.unknownAgency')}
                        </span>
                        <span className="text-muted-foreground">{target(r.target.kind, r.target.id)}</span>
                      </div>
                      <StateBadge label={t(`registrationStates.${r.state}`)} />
                      <span className="text-muted-foreground">
                        {t('row.registered')}: {date(r.registeredAt)} · {t('row.validUntil')}: {date(r.expiresAt)}
                      </span>
                    </li>
                  ))
                : null}
              {key === 'outViewings' || key === 'inViewings'
                ? (res.data.items as ViewingRequestDto[]).map((v) => (
                    <li key={v.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                      <div className="flex min-w-60 flex-1 flex-col">
                        <span className="font-medium">
                          {key === 'outViewings' ? t('row.owner') : t('row.introducedBy')}:{' '}
                          {v.counterpartName ?? t('row.unknownAgency')}
                        </span>
                        <span className="text-muted-foreground">
                          {[
                            target(v.target.kind, v.target.id),
                            v.awaiting ? t(`awaiting.${v.awaiting}`) : null,
                            v.outcome ? t(`outcomes.${v.outcome}`) : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </div>
                      <StateBadge label={t(`viewingStates.${v.status satisfies ViewingStatus}`)} />
                      <span className="text-muted-foreground">
                        {v.scheduledAt
                          ? `${t('row.scheduled')}: ${dateTime(v.scheduledAt)}`
                          : `${t('row.proposed')}: ${dateTime(v.proposedStartAt)}`}
                      </span>
                    </li>
                  ))
                : null}
            </ul>
          )}
          {res !== 'revoked' && res.ok && res.data.nextCursor ? (
            <Link
              href={{ pathname: '/collaborations', query: moreQuery(key, res.data.nextCursor) }}
              className="text-sm font-medium underline-offset-4 hover:underline"
            >
              {t('loadMore')}
            </Link>
          ) : null}
        </section>
      ))}
    </div>
  );
}

function StateBadge({ label }: { label: string }) {
  return <span className="rounded-md border px-2 py-0.5 text-xs">{label}</span>;
}
