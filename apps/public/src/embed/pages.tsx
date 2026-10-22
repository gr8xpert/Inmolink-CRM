/** @jsxImportSource @/embed/html */
import {
  PUBLIC_SEARCH_SORTS,
  TRANSACTION_TYPES,
  type WebsiteDetail,
  type WebsiteListingPage,
} from '@inmolink/contracts';
import { brandStyle, type EmbedBranding } from '@inmolink/core/modules/website-api';
import { EMBED_SCRIPT_PATH } from './client';
import { TURNSTILE_ORIGIN } from './csp';
import type { HtmlNode } from './html/jsx-runtime';
import { EMBED_CSS } from './styles';
import { EmbedCard, EmbedDetailView, type ViewText } from './views';

/**
 * Whole embed pages as HTML (S7-F8, perf review): server-rendered markup with no framework JavaScript — the views
 * rendered to static markup by the embed HTML runtime (`html/jsx-runtime.ts`), the stylesheet inline, and the one small script from 'self'
 * (`client.ts`) on the detail page. Every text is escaped.
 */

/** Error codes the enquiry form explains (`embed.lead.errors.*`); anything else is `generic`. */
export const EMBED_LEAD_ERRORS = [
  'VALIDATION_FAILED',
  'TURNSTILE_FAILED',
  'RATE_LIMITED',
  'LISTING_NOT_FOUND',
  'generic',
] as const;
export type EmbedLeadError = (typeof EMBED_LEAD_ERRORS)[number];
/** `?lead=` on the detail page after a plain (no-JavaScript) post. */
export type EmbedLeadNotice = 'sent' | EmbedLeadError;

export const TURNSTILE_SCRIPT = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js`;

function EmbedDocument(props: {
  lang: string;
  title: string;
  description?: string;
  branding: EmbedBranding;
  mediaOrigin: string | null;
  script?: boolean;
  t: ViewText['t'];
  children: HtmlNode;
}) {
  return (
    <html lang={props.lang}>
      {/* biome-ignore lint/style/noHeadElement: a whole document rendered to static HTML, not a Next page. */}
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        {props.description ? <meta name="description" content={props.description} /> : null}
        {/* Embeds are framed on the agency's site, which is the page to index. */}
        <meta name="robots" content="noindex, nofollow" />
        <link rel="icon" href="data:," />
        {props.mediaOrigin ? <link rel="preconnect" href={props.mediaOrigin} /> : null}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: our own constant stylesheet, no data in it. */}
        <style dangerouslySetInnerHTML={{ __html: EMBED_CSS }} />
        {props.script ? <script src={EMBED_SCRIPT_PATH} defer /> : null}
      </head>
      <body className="embed" style={brandStyle(props.branding)}>
        <header className="embed-header">
          <Brand branding={props.branding} t={props.t} />
        </header>
        <main className="embed-main">{props.children}</main>
      </body>
    </html>
  );
}

/** `<!DOCTYPE html>` + a document. */
function page(node: HtmlNode): string {
  return `<!DOCTYPE html>${String(node)}`;
}

function Brand({ branding, t }: { branding: EmbedBranding; t: ViewText['t'] }) {
  return <p className="embed-brand">{t('poweredBy', { agency: branding.name })}</p>;
}

/** The visitor's filters as typed (echoed into the form; validated separately). */
export interface EmbedFilters {
  q: string;
  transaction: string;
  priceMin: string;
  priceMax: string;
  bedsMin: string;
  sort: string;
}

export function renderSearchPage(props: {
  lang: string;
  base: string;
  branding: EmbedBranding;
  mediaOrigin: string | null;
  text: ViewText;
  filters: EmbedFilters;
  page: WebsiteListingPage;
  invalid: boolean;
  firstHref: string | null;
  nextHref: string | null;
}): string {
  const { t } = props.text;
  const f = props.filters;
  return page(
    <EmbedDocument
      lang={props.lang}
      title={`${t('search.title')} · ${props.branding.name}`}
      description={t('poweredBy', { agency: props.branding.name })}
      branding={props.branding}
      mediaOrigin={props.mediaOrigin}
      t={t}
    >
      <h1 className="embed-h1">{t('search.title')}</h1>
      <form method="get" action={props.base} className="embed-search" aria-label={t('search.label')}>
        <label className="embed-field">
          <span>{t('search.q')}</span>
          <input name="q" defaultValue={f.q} maxLength={100} />
        </label>
        <label className="embed-field">
          <span>{t('search.transaction')}</span>
          <select name="transaction">
            <option value="">{t('search.anyTransaction')}</option>
            {TRANSACTION_TYPES.map((v) => (
              <option key={v} value={v} selected={v === f.transaction}>
                {t(`search.transactions.${v}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="embed-field">
          <span>{t('search.priceMin')}</span>
          <input name="priceMin" inputMode="numeric" pattern="[0-9]*" defaultValue={f.priceMin} />
        </label>
        <label className="embed-field">
          <span>{t('search.priceMax')}</span>
          <input name="priceMax" inputMode="numeric" pattern="[0-9]*" defaultValue={f.priceMax} />
        </label>
        <label className="embed-field">
          <span>{t('search.bedsMin')}</span>
          <select name="bedsMin">
            <option value="">—</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n} selected={String(n) === f.bedsMin}>
                {n}+
              </option>
            ))}
          </select>
        </label>
        <label className="embed-field">
          <span>{t('search.sort')}</span>
          <select name="sort">
            {PUBLIC_SEARCH_SORTS.map((s) => (
              <option key={s} value={s} selected={s === (f.sort || 'newest')}>
                {t(`search.sorts.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="embed-button">
          {t('search.submit')}
        </button>
      </form>
      {props.invalid ? (
        <p role="status" className="embed-muted">
          {t('search.invalid')}
        </p>
      ) : null}
      <p className="embed-muted">{t('search.total', { count: props.page.total })}</p>
      {props.page.items.length === 0 ? (
        <p>{t('search.empty')}</p>
      ) : (
        <ul className="embed-results" data-testid="embed-results">
          {props.page.items.map((item, i) => (
            <EmbedCard
              key={item.ref}
              item={item}
              href={`${props.base}/listing/${encodeURIComponent(item.ref)}`}
              text={props.text}
              eager={i < 2}
            />
          ))}
        </ul>
      )}
      <nav className="embed-pager">
        {props.firstHref ? (
          <a href={props.firstHref} className="embed-link">
            {t('search.first')}
          </a>
        ) : null}
        {props.nextHref ? (
          <a href={props.nextHref} className="embed-link" rel="next">
            {t('search.next')}
          </a>
        ) : null}
      </nav>
    </EmbedDocument>,
  );
}

/**
 * The enquiry form: a plain POST to the detail URL (works without JavaScript, then answered by a redirect with a
 * notice); `client.ts` adds the idempotency key, Turnstile on first use and an in-place answer.
 */
export function EmbedLeadForm(props: {
  action: string;
  ref: string;
  agency: string;
  turnstileSiteKey: string;
  turnstileAction: string;
  t: ViewText['t'];
  notice?: EmbedLeadNotice;
}) {
  const { t } = props;
  const messages: Record<string, string> = { sent: t('lead.sent', { agency: props.agency }) };
  for (const c of EMBED_LEAD_ERRORS) messages[c] = t(`lead.errors.${c}`);
  const notice = props.notice ? messages[props.notice] : undefined;
  if (props.notice === 'sent') {
    return (
      <p role="status" className="embed-panel embed-notice" data-testid="embed-lead-sent">
        {notice}
      </p>
    );
  }
  return (
    <form
      method="post"
      action={props.action}
      className="embed-panel embed-form"
      aria-labelledby="embed-lead-title"
      data-embed-lead=""
      data-turnstile-script={TURNSTILE_SCRIPT}
      data-messages={JSON.stringify(messages)}
    >
      <h2 id="embed-lead-title" className="embed-h2">
        {t('lead.title')}
      </h2>
      <p role="status" className="embed-notice" data-embed-status="" hidden={!notice}>
        {notice}
      </p>
      {/* The challenge needs JavaScript: without it the form is still posted but refused, so say so first. */}
      <noscript>
        <p className="embed-error">{t('lead.needsJavaScript')}</p>
      </noscript>
      <input type="hidden" name="idempotencyKey" defaultValue="" />
      <label className="embed-field">
        <span>{t('lead.name')}</span>
        <input name="name" required maxLength={120} autoComplete="name" />
      </label>
      <label className="embed-field">
        <span>{t('lead.email')}</span>
        <input name="email" type="email" required maxLength={254} autoComplete="email" />
      </label>
      <label className="embed-field">
        <span>{t('lead.phone')}</span>
        <input name="phone" type="tel" maxLength={24} autoComplete="tel" />
      </label>
      <label className="embed-field">
        <span>{t('lead.message')}</span>
        <textarea
          name="message"
          required
          maxLength={4000}
          rows={4}
          defaultValue={t('lead.messageDefault', { ref: props.ref })}
        />
      </label>
      <label className="embed-check">
        <input type="checkbox" name="privacyAccepted" required />
        <span>{t('lead.privacy', { agency: props.agency })}</span>
      </label>
      <label className="embed-check">
        <input type="checkbox" name="marketingConsent" />
        <span>{t('lead.marketing')}</span>
      </label>
      <div className="cf-turnstile" data-sitekey={props.turnstileSiteKey} data-action={props.turnstileAction} />
      <button type="submit" className="embed-button">
        {t('lead.submit')}
      </button>
    </form>
  );
}

export function renderDetailPage(props: {
  lang: string;
  base: string;
  detail: WebsiteDetail;
  branding: EmbedBranding;
  mediaOrigin: string | null;
  text: ViewText;
  form: HtmlNode;
  withScript: boolean;
}): string {
  const { detail } = props;
  const description = detail.metaDescription ?? detail.description?.replace(/\s+/g, ' ').slice(0, 160) ?? undefined;
  return page(
    <EmbedDocument
      lang={props.lang}
      title={`${detail.metaTitle ?? detail.title} · ${props.branding.name}`}
      description={description}
      branding={props.branding}
      mediaOrigin={props.mediaOrigin}
      script={props.withScript}
      t={props.text.t}
    >
      <EmbedDetailView
        detail={detail}
        branding={props.branding}
        backHref={props.base}
        text={props.text}
        form={props.form}
      />
    </EmbedDocument>,
  );
}
