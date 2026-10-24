import { randomUUID } from 'node:crypto';
import { CALENDAR_EVENT_TYPES, type CalendarEventDto } from '@inmolink/contracts';
import { EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname, Link, redirect as localeRedirect } from '@/i18n/navigation';
import { agencyTimeZone } from '@/server/agency-time-zone';
import { sessionRef } from '@/server/api';
import { fetchCalendarEvents, fetchCalendarFeed } from '@/server/calendar-api';
import { addEventAction, eventIntentAction, revokeCalendarFeedAction, rotateCalendarFeedAction } from './actions';
import { CalendarFeedForm } from './feed-form';
import { FEED_ERRORS } from './feed-state';
import { dayKey, weekOf } from './week';

const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;
const ERROR_CODES = [
  'generic',
  'VERSION_CONFLICT',
  'CALENDAR_EVENT_NOT_FOUND',
  'VALIDATION_FAILED',
  'FORBIDDEN',
] as const;
type ErrorCode = (typeof ERROR_CODES)[number];
/** The list view shows four weeks from the week chosen. */
const LIST_DAYS = 28;
const DURATIONS = [15, 30, 45, 60, 90, 120, 180] as const;
const REMINDERS = ['none', '0', '15', '30', '60', '1440'] as const;

/**
 * Calendar (S10-06, PLAN §7 M8): the member's viewings, meetings and calls — a week (Monday to Sunday, the agency's
 * time zone) or a four-week list, mine or everyone's. Add an event, cancel or restore one, and get the private ICS
 * address that shows "my calendar" in Google Calendar or Outlook. Server-rendered: the only client code is the form
 * that shows a new feed address once.
 */
export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const params = await searchParams;
  const view = params.view === 'list' ? 'list' : 'week';
  const scope = params.scope === 'all' ? 'all' : 'mine';
  const cursor = typeof params.cursor === 'string' && CURSOR.test(params.cursor) ? params.cursor : undefined;
  const ref = sessionRef(session.user);
  const [timeZone, feed] = await Promise.all([agencyTimeZone(ref), fetchCalendarFeed(ref)]);
  const week = weekOf(params.week, new Date(), timeZone);
  const to = view === 'list' ? new Date(week.start.getTime() + LIST_DAYS * 86_400_000) : week.end;
  const t = await getTranslations('calendar');
  const format = await getFormatter();
  const res = await fetchCalendarEvents(ref, {
    from: week.start,
    to,
    attendee: scope === 'all' ? 'any' : 'me',
    cursor,
  });
  if (res === 'revoked' || feed === 'revoked') redirect('/session/expired');

  const base = { ...(view === 'list' ? { view } : {}), ...(scope === 'all' ? { scope } : {}) };
  const href = (extra: Record<string, string>) => ({ pathname: '/calendar' as const, query: { ...base, ...extra } });
  const error: ErrorCode | null = params.error
    ? (ERROR_CODES as readonly string[]).includes(params.error)
      ? (params.error as ErrorCode)
      : 'generic'
    : null;
  const hidden = (
    <>
      <input type="hidden" name="view" value={view} />
      <input type="hidden" name="week" value={week.key} />
      <input type="hidden" name="scope" value={scope} />
    </>
  );
  const time = (iso: string) => format.dateTime(new Date(iso), { timeStyle: 'short', timeZone });
  const dayLabel = (d: Date) => format.dateTime(d, { weekday: 'short', day: 'numeric', month: 'short', timeZone });
  const events = res.ok ? res.data.items : [];
  const byDay = new Map<string, CalendarEventDto[]>();
  for (const e of events) {
    // an event that began before the range (still running at its start) shows on its first day
    const start = new Date(e.startsAt);
    const k = start < week.start ? (week.days[0]?.key ?? '') : dayKey(start, timeZone);
    byDay.set(k, [...(byDay.get(k) ?? []), e]);
  }

  const eventItem = (e: CalendarEventDto) => {
    const cancelled = e.status === 'CANCELLED';
    const others = e.attendees.slice(1).map((a) => a.name ?? '…');
    return (
      <li key={e.id} className="flex flex-col gap-1 rounded-md border p-2 text-sm" data-testid="calendar-event">
        <span className="text-xs text-muted-foreground">
          {t('event.time', { from: time(e.startsAt), to: time(e.endsAt) })} · {t(`types.${e.type}`)}
          {cancelled ? ` · ${t('event.cancelled')}` : ''}
        </span>
        <span className={cancelled ? 'font-medium line-through' : 'font-medium'}>{e.title}</span>
        {e.location ? <span className="text-muted-foreground">{e.location}</span> : null}
        {others.length > 0 ? (
          <span className="text-muted-foreground">{t('event.with', { names: others.join(', ') })}</span>
        ) : null}
        <form action={eventIntentAction}>
          {hidden}
          <input type="hidden" name="id" value={e.id} />
          <input type="hidden" name="version" value={e.version} />
          <button
            type="submit"
            name="intent"
            value={cancelled ? 'restore' : 'cancel'}
            className="h-7 rounded-md border px-2 text-xs"
          >
            {cancelled ? t('actions.restore') : t('actions.cancel')}
          </button>
        </form>
      </li>
    );
  };

  const feedOn = feed.ok && feed.data.enabled;
  const doneHref = `${getPathname({ href: '/calendar', locale })}?${new URLSearchParams({ ...base, week: week.key }).toString()}`;

  return (
    <div className="flex flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${error}`)}
        </p>
      ) : null}
      {params.feed === 'off' ? (
        <p role="status" className="text-sm">
          {t('feed.revoked')}
        </p>
      ) : null}

      <nav aria-label={t('views.label')} className="flex flex-wrap items-center gap-4 text-sm">
        <Link href={href({ week: week.prev })} className="underline-offset-4 hover:underline">
          {t('nav.previous')}
        </Link>
        <span className="font-medium">
          {t('nav.range', { from: dayLabel(week.start), to: dayLabel(new Date(to.getTime() - 1)) })}
        </span>
        <Link href={href({ week: week.next })} className="underline-offset-4 hover:underline">
          {t('nav.next')}
        </Link>
        <Link href={href({})} className="underline-offset-4 hover:underline">
          {t('nav.today')}
        </Link>
        <span aria-hidden="true" className="text-muted-foreground">
          |
        </span>
        {(['week', 'list'] as const).map((v) => (
          <Link
            key={v}
            href={{
              pathname: '/calendar',
              query: { week: week.key, ...(v === 'list' ? { view: v } : {}), ...(scope === 'all' ? { scope } : {}) },
            }}
            aria-current={view === v ? 'page' : undefined}
            className={view === v ? 'font-semibold underline underline-offset-4' : 'underline-offset-4 hover:underline'}
          >
            {t(`views.${v}`)}
          </Link>
        ))}
        <span aria-hidden="true" className="text-muted-foreground">
          |
        </span>
        <span className="text-muted-foreground">{t('scope.label')}:</span>
        {(['mine', 'all'] as const).map((s) => (
          <Link
            key={s}
            href={{
              pathname: '/calendar',
              query: { week: week.key, ...(view === 'list' ? { view } : {}), ...(s === 'all' ? { scope: s } : {}) },
            }}
            aria-current={scope === s ? 'page' : undefined}
            className={
              scope === s ? 'font-semibold underline underline-offset-4' : 'underline-offset-4 hover:underline'
            }
          >
            {t(`scope.${s}`)}
          </Link>
        ))}
      </nav>

      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.load')}
        </p>
      ) : view === 'week' ? (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-7" data-testid="calendar-week">
          {week.days.map((d) => {
            const items = byDay.get(d.key) ?? [];
            return (
              <section key={d.key} aria-label={dayLabel(d.start)} className="flex flex-col gap-2 rounded-md border p-2">
                <h2 className="text-sm font-semibold">{dayLabel(d.start)}</h2>
                {items.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('empty.day')}</p>
                ) : (
                  <ul className="flex flex-col gap-2">{items.map(eventItem)}</ul>
                )}
              </section>
            );
          })}
        </div>
      ) : events.length === 0 ? (
        <EmptyState title={t('empty.list')} />
      ) : (
        <div className="flex flex-col gap-3" data-testid="calendar-list">
          {[...byDay.entries()].map(([key, items]) => (
            <section key={key} className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold">{dayLabel(new Date(items[0]?.startsAt ?? key))}</h2>
              <ul className="flex flex-col gap-2">{items.map(eventItem)}</ul>
            </section>
          ))}
        </div>
      )}
      {res.ok && res.data.nextCursor ? (
        <Link
          href={href({ week: week.key, cursor: res.data.nextCursor })}
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('loadMore')}
        </Link>
      ) : null}

      <form action={addEventAction} className="flex flex-wrap items-end gap-3 rounded-md border p-3 text-sm">
        <h2 className="w-full font-semibold">{t('form.heading')}</h2>
        {hidden}
        <input type="hidden" name="idempotencyKey" value={randomUUID()} />
        <label className="flex flex-col gap-1">
          <span>{t('form.type')}</span>
          <select name="type" className="h-9 rounded-md border bg-background px-2" defaultValue="VIEWING">
            {CALENDAR_EVENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`types.${type}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-60 flex-1 flex-col gap-1">
          <span>{t('form.title')}</span>
          <input name="title" required maxLength={200} className="h-9 rounded-md border bg-background px-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t('form.startsAt')}</span>
          <input name="startsAt" type="datetime-local" required className="h-9 rounded-md border bg-background px-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t('form.duration')}</span>
          <select name="duration" className="h-9 rounded-md border bg-background px-2" defaultValue="60">
            {DURATIONS.map((m) => (
              <option key={m} value={m}>
                {t('form.minutes', { count: m })}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-48 flex-col gap-1">
          <span>{t('form.location')}</span>
          <input name="location" maxLength={300} className="h-9 rounded-md border bg-background px-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t('form.remind')}</span>
          <select name="remind" className="h-9 rounded-md border bg-background px-2" defaultValue="30">
            {REMINDERS.map((r) => (
              <option key={r} value={r}>
                {r === 'none'
                  ? t('form.remindNone')
                  : r === '0'
                    ? t('form.remindAt')
                    : r === '1440'
                      ? t('form.remindDay')
                      : t('form.remindBefore', { count: Number(r) })}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="h-9 rounded-md border px-3 font-medium">
          {t('form.create')}
        </button>
      </form>

      <section className="flex flex-col gap-2 rounded-md border p-3 text-sm" aria-labelledby="calendar-feed-heading">
        <h2 id="calendar-feed-heading" className="font-semibold">
          {t('feed.heading')}
        </h2>
        <p className="text-muted-foreground">{t('feed.intro')}</p>
        <p>{feedOn && feed.ok ? t('feed.on', { hint: feed.data.tokenHint ?? '' }) : t('feed.off')}</p>
        <CalendarFeedForm
          action={rotateCalendarFeedAction}
          labels={{
            button: feedOn ? t('feed.rotate') : t('feed.create'),
            ...(feedOn ? { hint: t('feed.rotateHint') } : {}),
            issuedTitle: t('feed.issuedTitle'),
            issuedIntro: t('feed.issuedIntro'),
            url: t('feed.url'),
            done: t('feed.done'),
            doneHref,
            errors: Object.fromEntries(FEED_ERRORS.map((c) => [c, t(`feed.errors.${c}`)])) as Record<
              (typeof FEED_ERRORS)[number],
              string
            >,
          }}
        />
        {feedOn ? (
          <form action={revokeCalendarFeedAction}>
            {hidden}
            <button type="submit" className="h-8 rounded-md border px-3">
              {t('feed.revoke')}
            </button>
          </form>
        ) : null}
      </section>
    </div>
  );
}
