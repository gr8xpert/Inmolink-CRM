import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { ClientModeUnavailable } from '@/components/shell/client-mode-unavailable';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchContact } from '@/server/contacts-api';
import { fetchClientProfileMatches } from '@/server/matching-api';
import { inClientMode } from '@/server/nav';
import { loadShell } from '@/server/shell';
import { contactName } from '../contacts/lookup';
import { moveMatchAction } from './actions';
import { MatchList } from './match-list';
import { doneStatus, isUuid, parseQueueState, viewQuery } from './query';

/**
 * The review queue (R2-02d, PLAN §7 M9): what the match engine found for the clients' REVIEW profiles — approve
 * (the listing goes into a selection for the client; nothing is sent), dismiss, or restore a dismissed one. All the
 * agency's clients, or one contact's (`?contact=`) or one profile's (`?profile=`); newest first, "load more" by
 * cursor. Server-rendered, no client JS of its own; every rule (who may, what is still offerable) is the API's.
 */
export default async function MatchesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const shell = await loadShell();
  if (shell && inClientMode(shell.identity)) return <ClientModeUnavailable />;
  const q = await searchParams;
  const state = parseQueueState(q);
  const ref = sessionRef(session.user);
  const [res, contact] = await Promise.all([
    fetchClientProfileMatches(ref, {
      status: state.status,
      contactId: state.contact,
      profileId: state.profile,
      cursor: state.cursor,
    }),
    state.contact ? fetchContact(ref, state.contact) : Promise.resolve(null),
  ]);
  if (res === 'revoked' || contact === 'revoked') redirect('/session/expired');
  const t = await getTranslations('contacts.matchQueue');
  const te = await getTranslations('contacts.errors');
  const format = await getFormatter();
  const view = viewQuery(state);
  const done = doneStatus(q.done);
  const selection = isUuid(q.selection) ? q.selection : null;
  const errorCode = typeof q.error === 'string' ? q.error : null;
  const filterName =
    contact?.ok === true
      ? (contactName({ ...contact.data, primaryEmail: contact.data.emails[0], primaryPhone: contact.data.phones[0] }) ??
        t('noName'))
      : state.profile && res.ok && res.data.items[0]
        ? [res.data.items[0].contact.firstName, res.data.items[0].contact.lastName].filter(Boolean).join(' ') ||
          t('noName')
        : null;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>

      <nav aria-label={t('statusFilter')} className="flex flex-wrap items-center gap-2 text-sm">
        <span aria-hidden="true">{t('statusFilter')}:</span>
        {(['PENDING_REVIEW', 'DISMISSED'] as const).map((s) => (
          <Link
            key={s}
            href={{ pathname: '/matches', query: viewQuery({ ...state, status: s }) }}
            aria-current={state.status === s ? 'true' : undefined}
            className={
              state.status === s
                ? 'rounded-md border bg-muted px-3 py-1 font-medium'
                : 'rounded-md border px-3 py-1 underline-offset-4 hover:underline'
            }
          >
            {t(`statuses.${s}`)}
          </Link>
        ))}
        {state.contact || state.profile ? (
          <>
            {filterName ? <span className="ml-2">{t('forContact', { name: filterName })}</span> : null}
            <Link
              href={{ pathname: '/matches', query: viewQuery({ status: state.status }) }}
              className="underline-offset-4 hover:underline"
            >
              {t('clearFilter')}
            </Link>
          </>
        ) : null}
      </nav>

      {done ? (
        <p role="status" className="text-sm">
          {t.has(`done.${done}` as never) ? t(`done.${done}` as never) : null}{' '}
          {done === 'APPROVED' && selection ? (
            <Link href={`/selections/${selection}`} className="font-medium underline-offset-4 hover:underline">
              {t('openSelection')}
            </Link>
          ) : null}
        </p>
      ) : null}
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {te.has(errorCode as never) ? te(errorCode as never) : te('generic')}
        </p>
      ) : null}

      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {res.error?.code && te.has(res.error.code as never) ? te(res.error.code as never) : t('load')}
        </p>
      ) : (
        <>
          <MatchList
            items={res.data.items}
            status={state.status}
            t={(key, values) => t(key as never, values as never)}
            money={(amountCents, currency) =>
              format.number(amountCents / 100, { style: 'currency', currency, maximumFractionDigits: 0 })
            }
            number={(n) => format.number(n)}
            percent={(f) => format.number(f, { style: 'percent', maximumFractionDigits: 0 })}
            back={view}
            move={moveMatchAction}
            more={res.data.nextCursor !== null}
          />
          {res.data.nextCursor ? (
            <Link
              href={{ pathname: '/matches', query: { ...view, cursor: res.data.nextCursor } }}
              className="self-start text-sm font-medium underline-offset-4 hover:underline"
            >
              {t('loadMore')}
            </Link>
          ) : null}
        </>
      )}
    </div>
  );
}
