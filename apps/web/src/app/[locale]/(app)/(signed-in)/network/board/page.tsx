import { randomUUID } from 'node:crypto';
import { NETWORK_POST_KINDS, type NetworkPostKind, TRANSACTION_TYPES } from '@inmolink/contracts';
import { EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchTaxonomy, sessionRef } from '@/server/api';
import { fetchBoardPosts, fetchSubscriptions } from '@/server/network-api';
import { listingTaxonomy } from '../../listings/taxonomy';
import {
  addSubscriptionAction,
  closePostAction,
  createPostAction,
  deleteSubscriptionAction,
  replyAction,
} from './actions';

const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;
const ERRORS = [
  'generic',
  'load',
  'VALIDATION_FAILED',
  'FORBIDDEN',
  'VERIFICATION_REQUIRED',
  'RATE_LIMITED',
  'NETWORK_POST_NOT_FOUND',
  'NETWORK_POST_CLOSED',
  'NETWORK_SUBSCRIPTION_NOT_FOUND',
  'NETWORK_SUBSCRIPTION_LIMIT',
] as const;
const DONE = ['posted', 'closed', 'subscribed', 'unsubscribed'] as const;
const FIELD = 'h-9 rounded-md border bg-background px-2';

/**
 * The network board (S12-F1, PLAN §7 M11): open posts of the network's agencies — buyer requests, property offers,
 * distressed sales, developer announcements — with structured criteria; post your own, reply (which opens a chat thread
 * with the poster) and keep subscriptions that notify you of matching posts. Server-rendered; every rule is the API's.
 */
export default async function NetworkBoardPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const q = await searchParams;
  const kind = NETWORK_POST_KINDS.includes(q.kind as NetworkPostKind) ? (q.kind as NetworkPostKind) : undefined;
  const mine = q.mine === '1';
  const cursor = q.cursor && CURSOR.test(q.cursor) ? q.cursor : undefined;
  const done = DONE.find((d) => d === q.done);
  const error = ERRORS.find((e) => e === q.error);
  const t = await getTranslations('network.board');
  const format = await getFormatter();
  const ref = sessionRef(session.user);
  const [posts, subs, tax] = await Promise.all([
    fetchBoardPosts(ref, { limit: 25, cursor, kind, mine }),
    fetchSubscriptions(ref),
    fetchTaxonomy(ref),
  ]);
  if (posts === 'revoked' || subs === 'revoked' || tax === 'revoked') redirect('/session/expired');
  const { propertyTypes } = listingTaxonomy(tax.ok ? tax.data : null);
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });
  const euros = (cents: number | null) =>
    cents === null
      ? null
      : format.number(cents / 100, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const transaction = (v: (typeof TRANSACTION_TYPES)[number]) => t(`transactions.${v}`);
  const idempotencyKey = randomUUID();

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <Link href="/network" className="text-sm underline-offset-4 hover:underline">
          {t('toSearch')}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {done ? (
        <p role="status" className="text-sm text-green-700">
          {t(`done.${done}`)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${error}`)}
        </p>
      ) : null}

      <section aria-labelledby="board-post" className="flex flex-col gap-3 rounded-md border p-4">
        <h2 id="board-post" className="font-medium">
          {t('post.title')}
        </h2>
        <form action={createPostAction} className="grid gap-3 text-sm sm:grid-cols-2">
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <label className="flex flex-col gap-1">
            <span>{t('post.kind')}</span>
            <select name="kind" className={FIELD} defaultValue="PROPERTY_OFFER">
              {NETWORK_POST_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`kinds.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('post.titleLabel')}</span>
            <input name="title" required maxLength={120} className={FIELD} />
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span>{t('post.body')}</span>
            <textarea
              name="body"
              required
              maxLength={2000}
              rows={3}
              className="rounded-md border bg-background px-2 py-1"
            />
            <span className="text-xs text-muted-foreground">{t('post.bodyHelp')}</span>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('post.transaction')}</span>
            <select name="transactionType" className={FIELD} defaultValue="">
              <option value="">{t('post.any')}</option>
              {TRANSACTION_TYPES.map((v) => (
                <option key={v} value={v}>
                  {transaction(v)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('post.propertyType')}</span>
            <select name="propertyTypeId" className={FIELD} defaultValue="">
              <option value="">{t('post.any')}</option>
              {propertyTypes.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('post.priceMin')}</span>
            <input name="priceMin" inputMode="decimal" className={FIELD} />
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('post.priceMax')}</span>
            <input name="priceMax" inputMode="decimal" className={FIELD} />
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('post.beds')}</span>
            <input name="beds" inputMode="numeric" className={FIELD} />
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('post.expires')}</span>
            <input name="expiresInDays" inputMode="numeric" defaultValue="30" className={FIELD} />
          </label>
          <button type="submit" className="h-9 rounded-md border px-3 font-medium sm:col-span-2 sm:w-fit">
            {t('post.submit')}
          </button>
        </form>
      </section>

      <nav aria-label={t('filters.label')} className="flex flex-wrap items-center gap-4 text-sm">
        <Link
          href={{ pathname: '/network/board', query: mine ? { mine: '1' } : {} }}
          aria-current={kind ? undefined : 'page'}
          className={kind ? 'underline-offset-4 hover:underline' : 'font-semibold underline underline-offset-4'}
        >
          {t('filters.all')}
        </Link>
        {NETWORK_POST_KINDS.map((k) => (
          <Link
            key={k}
            href={{ pathname: '/network/board', query: { kind: k, ...(mine ? { mine: '1' } : {}) } }}
            aria-current={kind === k ? 'page' : undefined}
            className={kind === k ? 'font-semibold underline underline-offset-4' : 'underline-offset-4 hover:underline'}
          >
            {t(`kinds.${k}`)}
          </Link>
        ))}
        <span aria-hidden="true" className="text-muted-foreground">
          |
        </span>
        <Link
          href={{ pathname: '/network/board', query: { ...(kind ? { kind } : {}), ...(mine ? {} : { mine: '1' }) } }}
          aria-current={mine ? 'true' : undefined}
          className={mine ? 'font-semibold underline underline-offset-4' : 'underline-offset-4 hover:underline'}
        >
          {t('filters.mine')}
        </Link>
      </nav>

      {!posts.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.load')}
        </p>
      ) : posts.data.items.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <ul className="flex flex-col gap-3">
          {posts.data.items.map((p) => {
            const c = p.criteria;
            const range =
              c.priceMinCents !== null || c.priceMaxCents !== null
                ? `${euros(c.priceMinCents) ?? '…'} – ${euros(c.priceMaxCents) ?? '…'}`
                : null;
            const chips = [
              c.transactionType ? transaction(c.transactionType) : null,
              range,
              c.bedsMin !== null ? t('criteria.beds', { count: c.bedsMin }) : null,
            ].filter(Boolean);
            const open = p.status === 'OPEN' && !p.expired;
            return (
              <li key={p.id} data-testid="board-post" className="flex flex-col gap-2 rounded-md border p-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded border px-1.5 text-xs">{t(`kinds.${p.kind}`)}</span>
                  <h3 className="font-medium">{p.title}</h3>
                  {!open ? (
                    <span className="text-xs text-muted-foreground">{p.expired ? t('expired') : t('closed')}</span>
                  ) : null}
                </div>
                <p className="whitespace-pre-line">{p.body}</p>
                {chips.length > 0 ? <p className="text-muted-foreground">{chips.join(' · ')}</p> : null}
                <p className="text-xs text-muted-foreground">
                  {p.own ? t('byYou') : t('by', { agency: p.agency.name ?? t('unknownAgency') })} ·{' '}
                  {t('expires', { date: date(p.expiresAt) })}
                </p>
                {p.own && open ? (
                  <form action={closePostAction}>
                    <input type="hidden" name="id" value={p.id} />
                    <button type="submit" className="h-8 rounded-md border px-3">
                      {t('close')}
                    </button>
                  </form>
                ) : null}
                {!p.own && open ? (
                  <form action={replyAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="id" value={p.id} />
                    <input type="hidden" name="clientKey" value={randomUUID()} />
                    <label className="flex min-w-60 flex-1 flex-col gap-1">
                      <span>{t('reply.label')}</span>
                      <input name="body" required maxLength={4000} className={FIELD} />
                    </label>
                    <button type="submit" className="h-9 rounded-md border px-3 font-medium">
                      {t('reply.submit')}
                    </button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {posts.ok && posts.data.nextCursor ? (
        <Link
          href={{
            pathname: '/network/board',
            query: { cursor: posts.data.nextCursor, ...(kind ? { kind } : {}), ...(mine ? { mine: '1' } : {}) },
          }}
          className="text-sm underline underline-offset-4"
        >
          {t('more')}
        </Link>
      ) : null}

      <section aria-labelledby="board-subs" className="flex flex-col gap-3 rounded-md border p-4">
        <h2 id="board-subs" className="font-medium">
          {t('subscriptions.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('subscriptions.intro')}</p>
        {subs.ok && subs.data.items.length > 0 ? (
          <ul className="flex flex-col gap-2 text-sm">
            {subs.data.items.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3">
                <span className="font-medium">{s.name}</span>
                <span className="text-muted-foreground">
                  {[
                    s.kinds.map((k) => t(`kinds.${k}`)).join(', '),
                    s.transactionType ? transaction(s.transactionType) : null,
                    s.priceMaxCents !== null ? `≤ ${euros(s.priceMaxCents)}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <form action={deleteSubscriptionAction} className="ml-auto">
                  <input type="hidden" name="id" value={s.id} />
                  <button type="submit" className="h-8 rounded-md border px-3">
                    {t('subscriptions.delete')}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t('subscriptions.empty')}</p>
        )}
        <form action={addSubscriptionAction} className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex min-w-48 flex-col gap-1">
            <span>{t('subscriptions.name')}</span>
            <input name="name" required maxLength={80} className={FIELD} />
          </label>
          <fieldset className="flex flex-wrap gap-3">
            <legend className="mb-1">{t('subscriptions.kinds')}</legend>
            {NETWORK_POST_KINDS.map((k) => (
              <label key={k} className="flex items-center gap-1.5">
                <input type="checkbox" name="kinds" value={k} />
                {t(`kinds.${k}`)}
              </label>
            ))}
          </fieldset>
          <label className="flex flex-col gap-1">
            <span>{t('subscriptions.transaction')}</span>
            <select name="transactionType" className={FIELD} defaultValue="">
              <option value="">{t('post.any')}</option>
              {TRANSACTION_TYPES.map((v) => (
                <option key={v} value={v}>
                  {transaction(v)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('subscriptions.priceMax')}</span>
            <input name="priceMax" inputMode="decimal" className={FIELD} />
          </label>
          <button type="submit" className="h-9 rounded-md border px-3 font-medium">
            {t('subscriptions.add')}
          </button>
        </form>
      </section>
    </div>
  );
}
