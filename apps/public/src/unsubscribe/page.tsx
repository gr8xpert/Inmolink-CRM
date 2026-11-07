/** @jsxImportSource @/embed/html */
import { brandStyle, type EmbedBranding } from '@inmolink/core/modules/website-api';
import type { Translate } from '@inmolink/i18n/server';
import type { HtmlNode } from '@/embed/html/jsx-runtime';
import { EMBED_CSS } from '@/embed/styles';

/**
 * The unsubscribe page (R2-02g): `GET /u/<token>` asks the client to confirm (a link scanner's GET changes nothing),
 * the button POSTs the same body a mail client's one-click sends (`List-Unsubscribe=One-Click`), and the POST answers
 * the done page. Branded as the agency (its public name and colours, nothing else), static markup with every text
 * escaped and no JavaScript; an invalid link gets the neutral, unbranded page.
 */

export const NO_BRANDING: EmbedBranding = {
  name: '',
  email: null,
  phone: null,
  whatsapp: null,
  website: null,
  primaryColor: null,
  accentColor: null,
  logoUrl: null,
};

function Document(props: { lang: string; title: string; branding: EmbedBranding; children: HtmlNode }) {
  return (
    <html lang={props.lang}>
      {/* biome-ignore lint/style/noHeadElement: a whole document rendered to static HTML, not a Next page. */}
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <meta name="robots" content="noindex, nofollow" />
        <link rel="icon" href="data:," />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: our own constant stylesheet, no data in it. */}
        <style dangerouslySetInnerHTML={{ __html: EMBED_CSS }} />
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

const page = (node: HtmlNode) => `<!DOCTYPE html>${String(node)}`;

/** The confirm page: one button that POSTs the one-click body to `action`. */
export function renderUnsubscribeConfirm(props: {
  lang: string;
  t: Translate;
  branding: EmbedBranding;
  action: string;
}): string {
  const { t, branding } = props;
  return page(
    <Document lang={props.lang} title={t('unsubscribe.title')} branding={branding}>
      <h1 className="embed-h1">{t('unsubscribe.title')}</h1>
      <p>{branding.name ? t('unsubscribe.intro', { agency: branding.name }) : t('unsubscribe.introNeutral')}</p>
      <form method="post" action={props.action} className="embed-form">
        <input type="hidden" name="List-Unsubscribe" value="One-Click" />
        <button type="submit" className="embed-button">
          {t('unsubscribe.confirm')}
        </button>
      </form>
    </Document>,
  );
}

/** The done page (the POST's answer). */
export function renderUnsubscribeDone(props: { lang: string; t: Translate; branding: EmbedBranding }): string {
  const { t } = props;
  return page(
    <Document lang={props.lang} title={t('unsubscribe.doneTitle')} branding={props.branding}>
      <h1 className="embed-h1">{t('unsubscribe.doneTitle')}</h1>
      <p className="embed-notice">{t('unsubscribe.done')}</p>
    </Document>,
  );
}

/** A neutral page for an invalid link or too many requests: no branding, nothing about any agency or contact. */
export function renderUnsubscribeRefused(props: { lang: string; t: Translate; limited?: boolean }): string {
  const { t } = props;
  const title = props.limited ? t('unsubscribe.limited') : t('unsubscribe.gone');
  return page(
    <Document lang={props.lang} title={title} branding={NO_BRANDING}>
      <h1 className="embed-h1">{title}</h1>
      {props.limited ? null : <p className="embed-muted">{t('unsubscribe.goneHint')}</p>}
    </Document>,
  );
}
