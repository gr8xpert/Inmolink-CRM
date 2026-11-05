import {
  REGISTRATION_TARGET_KINDS,
  type ReceivedRegistrationDto,
  type RegistrationDto,
  type RegistrationTargetKind,
  type TargetLabel,
  VIEWING_STATUSES,
  type ViewingRequestDto,
  type ViewingStatus,
} from '@inmolink/contracts';
import { EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { ClientModeUnavailable } from '@/components/shell/client-mode-unavailable';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { agencyTimeZone } from '@/server/agency-time-zone';
import { sessionRef } from '@/server/api';
import {
  fetchListingOwners,
  fetchOpenViewingRegistrations,
  fetchOwnRegistrations,
  fetchOwnViewings,
  fetchReceivedRegistrations,
  fetchReceivedViewings,
} from '@/server/collaborations-api';
import { inClientMode, isAdminMember } from '@/server/nav';
import { loadShell } from '@/server/shell';
import { BlockNotice } from './block-notice';
import { collaborationQuery, parseCollaborationParams, type SectionKey, sectionsFor } from './filters';
import { loadCollaborationBlock } from './load-rights';
import { parseDone, parseRefusal } from './refusals';
import { RequestViewingForm } from './request-viewing-form';
import { termsText } from './terms-text';
import { mayBind } from './viewing-controls';
import { ViewingRowControls } from './viewing-row-controls';

const OPEN = new Set<ViewingStatus>(['REQUESTED', 'SCHEDULED']);

/**
 * My collaborations (S11-06, PLAN §7 M10): the agency's client registrations and viewing requests, introduced by it (out)
 * and received for its own listings and developments (in), with state, direction, type, target and date filters.
 * Server-rendered. Unfiltered it shows the first rows of each of the four lists (a handful of queries in all); a chosen
 * direction and type is one list, paged by cursor. The owner's side never shows the client (the API strips it).
 * S17-F56: request a viewing on an active registration, and each side's answers on a viewing row (`viewing-controls.ts`).
 */
export default async function CollaborationsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  // S17-F52: the API refuses it in Client Mode; say so, as every other closed page does.
  const clientShell = await loadShell();
  if (clientShell && inClientMode(clientShell.identity)) return <ClientModeUnavailable />;
  const params = await searchParams;
  const f = parseCollaborationParams(params);
  const refusal = parseRefusal(params.error);
  const done = parseDone(params.done);
  const t = await getTranslations('network.collaborations');
  const commission = await getTranslations('network.commission');
  const format = await getFormatter();
  const ref = sessionRef(session.user);
  const sections = sectionsFor(f);
  const single = sections.length === 1;
  const base = { limit: single ? 25 : 10, cursor: single ? f.cursor : undefined, kind: f.kind, from: f.from, to: f.to };
  const [block, timeZone] = await Promise.all([loadCollaborationBlock(ref), agencyTimeZone(ref)]);
  const now = new Date();
  const back = new URLSearchParams(collaborationQuery(f)).toString();
  // The viewing's time as the agency's wall clock, as the time inputs take it.
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeZone });
  const dateTime = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short', timeZone });
  const termsLine = (v: ViewingRequestDto) =>
    termsText(v.terms, {
      t: (key, values) => commission(key, values),
      money: (m) =>
        format.number(m.amountCents / 100, { style: 'currency', currency: m.currency, maximumFractionDigits: 0 }),
      percent: (bp) => format.number(bp / 10_000, { style: 'percent', maximumFractionDigits: 2 }),
    });
  // The reference and title (S12-F21); a target the agency can no longer read falls back to kind + id fragment.
  const target = (k: RegistrationTargetKind, id: string, label: TargetLabel | null) =>
    label
      ? `${t(`kinds.${k}`)} ${label.reference}${label.title ? ` · ${label.title}` : ''}`
      : `${t(`kinds.${k}`)} ${id.slice(0, 8)}`;

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

  const rowsOf = <T,>(key: SectionKey): T[] => {
    const res = results.find(([k]) => k === key)?.[1];
    return res && res !== 'revoked' && res.ok ? (res.data.items as T[]) : [];
  };
  // Not offering what the API would refuse takes two more lookups, only where they can change what is shown.
  const hasActive = !block && rowsOf<RegistrationDto>('outRegistrations').some((r) => r.state === 'ACTIVE');
  const isAdmin = clientShell ? isAdminMember(clientShell.identity) : false;
  const ownerListings = rowsOf<ViewingRequestDto>('inViewings')
    .filter((v) => OPEN.has(v.status) && v.target.kind === 'LISTING')
    .map((v) => v.target.id);
  const [openRegistrations, listingOwners] = await Promise.all([
    hasActive ? fetchOpenViewingRegistrations(ref) : new Set<string>(),
    !block && !isAdmin ? fetchListingOwners(ref, ownerListings) : new Map<string, string | null>(),
  ]);
  if (openRegistrations === 'revoked' || listingOwners === 'revoked') redirect('/session/expired');
  const member = { isAdmin, userId: session.user.id };

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
      {block ? <BlockNotice block={block} /> : null}
      {refusal ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${refusal}`)}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {t(`done.${done}`)}
        </p>
      ) : null}

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
                        <span className="text-muted-foreground">
                          {target(r.target.kind, r.target.id, r.targetLabel)}
                        </span>
                      </div>
                      <StateBadge label={t(`registrationStates.${r.state}`)} />
                      <span className="text-muted-foreground">
                        {t('row.registered')}: {date(r.registeredAt)} · {t('row.validUntil')}: {date(r.expiresAt)}
                      </span>
                      {block || r.state !== 'ACTIVE' ? null : openRegistrations.has(r.id) ? (
                        <p className="basis-full text-muted-foreground">{t('request.open')}</p>
                      ) : (
                        <RequestViewingForm
                          registrationId={r.id}
                          until={r.expiresAt}
                          now={now}
                          timeZone={timeZone}
                          back={back}
                        />
                      )}
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
                        <span className="text-muted-foreground">
                          {target(r.target.kind, r.target.id, r.targetLabel)}
                        </span>
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
                            target(v.target.kind, v.target.id, v.targetLabel),
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
                      <p className="basis-full text-muted-foreground">{termsLine(v)}</p>
                      <div className="basis-full">
                        <ViewingRowControls
                          viewing={v}
                          now={now}
                          blocked={block !== null}
                          mayBind={mayBind(v, member, listingOwners)}
                          timeZone={timeZone}
                          back={back}
                        />
                      </div>
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
