import { randomUUID } from 'node:crypto';
import type { SiteDto, SiteFeedDto } from '@inmolink/contracts';
import { Button } from '@inmolink/ui';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { getPathname } from '@/i18n/navigation';
import { revokeFeedAction, rotateFeedAction } from './feed-actions';
import { RotateFeedForm } from './feed-forms';
import { FEED_ERRORS, type FeedError } from './feed-state';

/**
 * The website's XML feed card (S7-F8, PLAN §9.5): on or off, the live token's last characters, the last run and its
 * Kyero vs generic counts; admins turn it on (URLs shown once), rotate the token or turn it off (the API refuses
 * everyone else). Server component; only the rotate form is a client island.
 */
export async function FeedCard({
  site,
  feed,
  notice,
  error,
}: {
  site: SiteDto;
  feed: SiteFeedDto | null;
  notice?: string;
  error?: string;
}) {
  const t = await getTranslations('websites.feed');
  const fmt = await getFormatter();
  const locale = await getLocale();
  const errors = Object.fromEntries(FEED_ERRORS.map((c) => [c, t(`errors.${c}`)])) as Record<FeedError, string>;
  const issued = {
    title: t('issuedTitle'),
    intro: t('issuedIntro'),
    kyero: t('kyeroUrl'),
    generic: t('genericUrl'),
    done: t('done'),
    doneHref: getPathname({ href: `/websites/${site.id}`, locale }),
  };
  const known = FEED_ERRORS.find((c) => c === error);
  const on = feed?.enabled === true;
  return (
    <section className="flex flex-col gap-3 rounded-md border p-4" aria-labelledby="feed-title" data-testid="feed-card">
      <h2 id="feed-title" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {notice === 'off' ? (
        <p role="status" className="rounded-md border bg-muted p-3 text-sm">
          {t('turnedOff')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {known ? errors[known] : errors.generic}
        </p>
      ) : null}
      {feed === null ? (
        <p role="alert" className="text-sm text-destructive">
          {errors.generic}
        </p>
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="font-medium">{t('status')}</dt>
          <dd data-testid="feed-status">{on ? t('on') : t('off')}</dd>
          {on && feed.tokenHint && feed.tokenCreatedAt ? (
            <>
              <dt className="font-medium">{t('token')}</dt>
              <dd className="font-mono text-xs">
                {t('tokenHint', {
                  hint: feed.tokenHint,
                  date: fmt.dateTime(new Date(feed.tokenCreatedAt), { dateStyle: 'medium' }),
                })}
              </dd>
            </>
          ) : null}
          {on ? (
            <>
              <dt className="font-medium">{t('lastRun')}</dt>
              <dd>
                {feed.generatedAt
                  ? fmt.dateTime(new Date(feed.generatedAt), { dateStyle: 'medium', timeStyle: 'short' })
                  : t('never')}
              </dd>
              {feed.itemCount !== null ? (
                <>
                  <dt className="font-medium">{t('counts')}</dt>
                  <dd>
                    {feed.kyeroCount === null ? '—' : t('kyeroCount', { count: feed.kyeroCount })} ·{' '}
                    {t('genericCount', { count: feed.itemCount })}
                  </dd>
                </>
              ) : null}
            </>
          ) : null}
        </dl>
      )}
      {on && feed?.lastError ? (
        <p role="alert" className="text-sm text-destructive">
          {t('lastError', { code: feed.lastError })}
        </p>
      ) : null}
      {feed !== null ? (
        <div className="flex flex-wrap items-start gap-4">
          <RotateFeedForm
            action={rotateFeedAction}
            siteId={site.id}
            idempotencyKey={`feed-${randomUUID()}`}
            label={on ? t('rotate') : t('turnOn')}
            hint={on ? t('rotateHint') : undefined}
            issued={issued}
            errors={errors}
          />
          {on ? (
            <form action={revokeFeedAction}>
              <input type="hidden" name="siteId" value={site.id} />
              <Button type="submit" variant="outline" size="sm">
                {t('turnOff')}
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** IFRAME sites (S7-F8): the embed address to paste into an iframe, and where it may be shown. */
export async function EmbedCard({ site, pagesUrl }: { site: SiteDto; pagesUrl: string }) {
  const t = await getTranslations('websites.feed');
  const url = `${pagesUrl}/embed/${site.id}/${site.locales[0] ?? 'en'}`;
  return (
    <section className="flex flex-col gap-2 rounded-md border p-4" aria-labelledby="embed-title">
      <h2 id="embed-title" className="text-lg font-semibold">
        {t('embedTitle')}
      </h2>
      {site.domains.length > 0 ? (
        <>
          <p className="text-sm text-muted-foreground">{t('embedIntro', { domains: site.domains.join(', ') })}</p>
          <code className="break-all rounded-md bg-muted p-2 font-mono text-xs" data-testid="embed-url">
            {url}
          </code>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t('embedNoDomain')}</p>
      )}
    </section>
  );
}
