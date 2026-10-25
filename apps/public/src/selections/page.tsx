/** @jsxImportSource @/embed/html */
import type { WebsiteDetail, WebsiteImage } from '@inmolink/contracts';
import type { SelectionPageItem, SelectionPageModel } from '@inmolink/core/modules/presentations';
import { brandStyle, type EmbedBranding } from '@inmolink/core/modules/website-api';
import type { HtmlNode } from '@/embed/html/jsx-runtime';
import { EMBED_CSS } from '@/embed/styles';
import { EmbedContact, facts, HERO_SIZES, Picture, placeText, priceText, type ViewText } from '@/embed/views';

/**
 * The selection page (S12-04): a client's live, branded list of the properties an agent picked — rendered by the
 * embed HTML runtime to static markup (every text escaped; no HTML from data), with no JavaScript at all: likes and
 * enquiries are plain form posts answered by a redirect. Its own sheet on top of the embed one, inline.
 */

export const SELECTION_CSS = `
.sel-intro{margin:.25rem 0 1rem}
.sel-message{white-space:pre-line;border-left:4px solid var(--embed-accent);padding:.25rem .75rem;margin:0 0 1rem}
.sel-items{list-style:none;padding:0;margin:0;display:grid;gap:1.5rem}
.sel-item{border:1px solid #e5e7eb;border-radius:8px;overflow:hidden}
.sel-media{aspect-ratio:4/3;background:#f3f4f6;display:flex;align-items:center;justify-content:center}
.sel-media img{width:100%;height:100%;object-fit:cover;display:block}
.sel-body{padding:1rem;display:grid;gap:.5rem}
.sel-note{white-space:pre-line;background:#f9fafb;border-radius:6px;padding:.5rem .75rem;margin:0}
.sel-desc{white-space:pre-line;margin:.5rem 0 0}
.sel-actions{display:flex;flex-wrap:wrap;gap:.5rem;align-items:flex-start}
.sel-actions form{margin:0}
.sel-ghost{background:transparent;color:inherit;border:1px solid #6b7280}
.embed-notice{background:#ecfdf5;border:1px solid #10b981;border-radius:6px;padding:.5rem .75rem}
.embed-error{background:#fef2f2;border:1px solid #ef4444;border-radius:6px;padding:.5rem .75rem}
@media (min-width:720px){.sel-item{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,3fr)}.sel-media{aspect-ratio:auto;min-height:100%}}
`;

export type SelectionNotice = 'liked' | 'unliked' | 'sent' | 'invalid' | 'limited' | 'error';

const imageOf = (d: WebsiteDetail): WebsiteImage | null =>
  d.kind === 'LISTING'
    ? (d.cover ?? (d.media.find((m) => m.kind !== 'VIDEO') as WebsiteImage | undefined) ?? null)
    : null;

function Document(props: {
  lang: string;
  title: string;
  description?: string;
  image?: string;
  branding: EmbedBranding;
  mediaOrigin: string | null;
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
        {/* A client's private link: never indexed; the link preview (WhatsApp, e-mail apps) shows its title. */}
        <meta name="robots" content="noindex, nofollow" />
        <meta property="og:title" content={props.title} />
        {props.description ? <meta property="og:description" content={props.description} /> : null}
        {props.image ? <meta property="og:image" content={props.image} /> : null}
        <link rel="icon" href="data:," />
        {props.mediaOrigin ? <link rel="preconnect" href={props.mediaOrigin} /> : null}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: our own constant stylesheets, no data in them. */}
        <style dangerouslySetInnerHTML={{ __html: EMBED_CSS + SELECTION_CSS }} />
      </head>
      <body className="embed" style={brandStyle(props.branding)}>
        <header className="embed-header">
          <p className="embed-brand">{props.branding.name}</p>
        </header>
        <main className="embed-main">{props.children}</main>
      </body>
    </html>
  );
}

function Item(props: { item: SelectionPageItem; index: number; action: string; text: ViewText; liked: boolean }) {
  const { item, text } = props;
  const { t } = text;
  const d = item.detail;
  const anchor = `item-${item.targetId}`;
  if (!d) {
    return (
      <li className="sel-item" id={anchor}>
        <div className="sel-body">
          <p className="embed-muted">{t('selection.unavailable')}</p>
          {item.note ? <p className="sel-note">{item.note}</p> : null}
        </div>
      </li>
    );
  }
  const image = imageOf(d);
  const features = d.kind === 'LISTING' ? d.features : [];
  return (
    <li className="sel-item" id={anchor}>
      <div className="sel-media">
        {image ? (
          <Picture image={image} alt={image.alt ?? d.title} sizes={HERO_SIZES} eager={props.index === 0} />
        ) : (
          <span className="embed-muted">{t('card.noPhoto')}</span>
        )}
      </div>
      <div className="sel-body">
        <p className="embed-price">{priceText(d.price, text)}</p>
        <h2 className="embed-card-title">{d.title}</h2>
        <p className="embed-muted">{placeText(d.place)}</p>
        <p className="embed-facts">{facts(d, text).join(' · ')}</p>
        <p className="embed-muted embed-small">{t('card.ref', { ref: d.ref })}</p>
        {item.note ? (
          <p className="sel-note">
            <strong>{t('selection.note')}: </strong>
            {item.note}
          </p>
        ) : null}
        {d.description || features.length > 0 ? (
          <details>
            <summary>{t('selection.details')}</summary>
            {d.description ? <p className="sel-desc">{d.description}</p> : null}
            {features.length > 0 ? <p className="embed-muted">{features.map((f) => f.name).join(' · ')}</p> : null}
          </details>
        ) : null}
        <div className="sel-actions">
          <form method="post" action={`${props.action}#${anchor}`}>
            <input type="hidden" name="action" value={props.liked ? 'unlike' : 'like'} />
            <input type="hidden" name="item" value={item.targetId} />
            <button type="submit" className={props.liked ? 'embed-button sel-ghost' : 'embed-button'}>
              {props.liked ? t('selection.unlike') : t('selection.like')}
            </button>
          </form>
          <details>
            <summary className="embed-link">{t('selection.enquire')}</summary>
            <form method="post" action={`${props.action}#${anchor}`} className="embed-form">
              <input type="hidden" name="action" value="enquire" />
              <input type="hidden" name="item" value={item.targetId} />
              <label className="embed-field">
                <span>{t('selection.message')}</span>
                <textarea name="message" required maxLength={2000} rows={3} />
              </label>
              <button type="submit" className="embed-button">
                {t('selection.send')}
              </button>
            </form>
          </details>
        </div>
      </div>
    </li>
  );
}

/** The whole page of a live selection. `liked`: the items this browser liked (from the page's own redirects). */
export function renderSelectionPage(props: {
  model: SelectionPageModel;
  branding: EmbedBranding;
  action: string;
  mediaOrigin: string | null;
  text: ViewText;
  notice?: { kind: SelectionNotice; item?: string };
  liked: ReadonlySet<string>;
}): string {
  const { model, branding, text } = props;
  const { t, fmt } = text;
  const first = model.items.map((i) => (i.detail ? imageOf(i.detail) : null)).find(Boolean) ?? null;
  const noticeText = props.notice
    ? props.notice.kind === 'sent'
      ? t('selection.sent', { agency: branding.name })
      : t(`selection.${props.notice.kind}`)
    : null;
  const bad = props.notice && ['invalid', 'limited', 'error'].includes(props.notice.kind);
  return `<!DOCTYPE html>${String(
    <Document
      lang={model.locale}
      title={t('selection.pageTitle', { title: model.title, agency: branding.name })}
      description={model.message?.replace(/\s+/g, ' ').slice(0, 160) ?? t('selection.intro', { agency: branding.name })}
      image={first?.urls.medium ?? first?.urls.small ?? undefined}
      branding={branding}
      mediaOrigin={props.mediaOrigin}
    >
      <h1 className="embed-h1">{model.title}</h1>
      <p className="embed-muted sel-intro">
        {t('selection.intro', { agency: branding.name })} · {t('selection.count', { count: model.items.length })}
        {model.expiresAt ? ` · ${t('selection.expires', { date: fmt.date(model.expiresAt) })}` : ''}
      </p>
      {model.message ? <p className="sel-message">{model.message}</p> : null}
      {noticeText ? (
        <p role="status" className={bad ? 'embed-error' : 'embed-notice'} data-testid="selection-notice">
          {noticeText}
        </p>
      ) : null}
      <ol className="sel-items">
        {model.items.map((item, i) => (
          <Item
            key={item.targetId}
            item={item}
            index={i}
            action={props.action}
            text={text}
            liked={props.liked.has(item.targetId)}
          />
        ))}
      </ol>
      <section className="embed-panel" aria-labelledby="sel-enquire">
        <h2 id="sel-enquire" className="embed-h2">
          {t('selection.enquireAll', { agency: branding.name })}
        </h2>
        <form method="post" action={props.action} className="embed-form">
          <input type="hidden" name="action" value="enquire" />
          <label className="embed-field">
            <span>{t('selection.message')}</span>
            <textarea name="message" required maxLength={2000} rows={3} />
          </label>
          <button type="submit" className="embed-button">
            {t('selection.send')}
          </button>
        </form>
      </section>
      <EmbedContact branding={branding} t={t} />
    </Document>,
  )}`;
}

/** The page of a token that names no live selection (unknown, expired, replaced or revoked). */
export function renderGonePage(props: { lang: string; text: ViewText }): string {
  const { t } = props.text;
  const branding: EmbedBranding = {
    name: '',
    email: null,
    phone: null,
    whatsapp: null,
    website: null,
    primaryColor: null,
    accentColor: null,
    logoUrl: null,
  };
  return `<!DOCTYPE html>${String(
    <Document lang={props.lang} title={t('selection.gone')} branding={branding} mediaOrigin={null}>
      <h1 className="embed-h1">{t('selection.gone')}</h1>
      <p className="embed-muted">{t('selection.goneHint')}</p>
    </Document>,
  )}`;
}
