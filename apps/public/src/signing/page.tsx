/** @jsxImportSource @/embed/html */
import type { SigningPageModel } from '@inmolink/core/modules/documents';
import { brandStyle, type EmbedBranding } from '@inmolink/core/modules/website-api';
import type { Translate } from '@inmolink/i18n/server';
import type { HtmlNode } from '@/embed/html/jsx-runtime';
import { TURNSTILE_SCRIPT } from '@/embed/pages';
import { EMBED_CSS } from '@/embed/styles';

/**
 * The signing page (R2-05b): static markup, every text escaped. `GET /sign/<token>` shows the document (its label, its
 * SHA-256, a link to the PDF), then two forms posting to the same URL: "e-mail me a code" (`action=code`, with
 * Turnstile when configured) and the signature (`action=sign`: the code, the name, typed or drawn, the consent, and
 * the hash shown). The drawing pad is the only script (`client.ts`, from 'self'); without it the signer types their
 * name. Branded with the agency's name as the form states it; an invalid link gets the neutral page.
 */

const SIGN_CSS = `
.sign-hash{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.8rem;word-break:break-all}
.sign-step{border-top:1px solid #e5e7eb;padding-top:1rem;margin-top:1rem}
.sign-pad{border:1px solid #6b7280;border-radius:6px;background:#fff;width:100%;max-width:560px;height:auto;touch-action:none}
.sign-kinds{display:flex;flex-direction:column;gap:.35rem;border:0;padding:0;margin:0}
.sign-secondary{background:transparent;border:1px solid #6b7280;border-radius:6px;padding:.4rem .8rem;font:inherit;cursor:pointer}
`;

const brandingOf = (name: string | null): EmbedBranding => ({
  name: name ?? '',
  email: null,
  phone: null,
  whatsapp: null,
  website: null,
  primaryColor: null,
  accentColor: null,
  logoUrl: null,
});

function Document(props: {
  lang: string;
  title: string;
  agency: string | null;
  scripts?: readonly string[];
  children: HtmlNode;
}) {
  return (
    <html lang={props.lang}>
      {/* biome-ignore lint/style/noHeadElement: a whole document rendered to static HTML, not a Next page. */}
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <meta name="robots" content="noindex, nofollow" />
        <link rel="icon" href="data:," />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: our own constant stylesheets, no data in them. */}
        <style dangerouslySetInnerHTML={{ __html: EMBED_CSS + SIGN_CSS }} />
        {(props.scripts ?? []).map((src) => (
          <script key={src} src={src} defer />
        ))}
      </head>
      <body className="embed" style={brandStyle(brandingOf(props.agency))}>
        <header className="embed-header">
          <p className="embed-brand">{props.agency ?? ''}</p>
        </header>
        <main className="embed-main">{props.children}</main>
      </body>
    </html>
  );
}

const page = (node: HtmlNode) => `<!DOCTYPE html>${String(node)}`;

export interface SigningNotice {
  kind: 'error' | 'info';
  text: string;
}

function Summary(props: { t: Translate; model: SigningPageModel; documentHref: string | null }) {
  const { t, model } = props;
  return (
    <section>
      <dl className="embed-facts-list">
        <dt>{t('signing.page.document')}</dt>
        <dd>{model.documentLabel}</dd>
        <dt>{t('signing.page.hash')}</dt>
        <dd className="sign-hash">{model.documentSha256}</dd>
      </dl>
      {props.documentHref ? (
        <p>
          <a className="embed-link" href={props.documentHref} target="_blank" rel="noopener noreferrer">
            {t('signing.page.view')}
          </a>
        </p>
      ) : null}
    </section>
  );
}

export interface SigningPageProps {
  lang: string;
  t: Translate;
  model: SigningPageModel;
  /** The role label (`forms.signers.<role>`). */
  roleLabel: string;
  /** Where both forms post (`/sign/<token>?l=<lang>`). */
  action: string;
  /** The PDF's link on this host, or null when it cannot be opened here. */
  documentHref: string | null;
  turnstileSiteKey: string | null;
  turnstileAction: string;
  scriptPath: string;
  notice?: SigningNotice | null;
  /** A code was just sent (the sign form comes first). */
  codeSent?: boolean;
}

/** The page of an open request: the document, the code form and the signature form. */
export function renderSigningPage(props: SigningPageProps): string {
  const { t, model } = props;
  const intro = model.agencyName
    ? t('signing.page.intro', { agency: model.agencyName })
    : t('signing.page.introNeutral');
  const scripts = [props.scriptPath, ...(props.turnstileSiteKey ? [TURNSTILE_SCRIPT] : [])];
  return page(
    <Document lang={props.lang} title={t('signing.page.title')} agency={model.agencyName} scripts={scripts}>
      <h1 className="embed-h1">{t('signing.page.title')}</h1>
      <p>{intro}</p>
      <p>{t('signing.page.signAs', { role: props.roleLabel })}</p>
      <Summary t={t} model={model} documentHref={props.documentHref} />
      {props.notice ? (
        <p
          role={props.notice.kind === 'error' ? 'alert' : 'status'}
          className={props.notice.kind === 'error' ? 'embed-error' : 'embed-notice'}
        >
          {props.notice.text}
        </p>
      ) : null}
      <form method="post" action={props.action} className="embed-form sign-step" aria-labelledby="sign-code-title">
        <h2 id="sign-code-title" className="embed-h">
          {t('signing.page.codeStep')}
        </h2>
        <p className="embed-muted">{t('signing.page.codeHint', { email: model.emailHint })}</p>
        <input type="hidden" name="action" value="code" />
        {props.turnstileSiteKey ? (
          <div className="cf-turnstile" data-sitekey={props.turnstileSiteKey} data-action={props.turnstileAction} />
        ) : null}
        <button type="submit" className={props.codeSent ? 'sign-secondary' : 'embed-button'}>
          {t('signing.page.sendCode')}
        </button>
      </form>
      <form
        method="post"
        action={props.action}
        className="embed-form sign-step"
        aria-labelledby="sign-title"
        data-sign-form=""
      >
        <h2 id="sign-title" className="embed-h">
          {t('signing.page.signStep')}
        </h2>
        <input type="hidden" name="action" value="sign" />
        <input type="hidden" name="documentSha256" value={model.documentSha256} />
        <input type="hidden" name="drawing" value="" />
        <label className="embed-field">
          <span>{t('signing.page.code')}</span>
          <input
            name="code"
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 \-]{6,9}"
            maxLength={9}
          />
        </label>
        <label className="embed-field">
          <span>{t('signing.page.name')}</span>
          <input name="name" required maxLength={200} autoComplete="name" defaultValue={model.name} />
        </label>
        <fieldset className="sign-kinds">
          <legend>{t('signing.page.kind')}</legend>
          <label className="embed-check">
            <input type="radio" name="kind" value="TYPED" defaultChecked />
            <span>{t('signing.page.typed')}</span>
          </label>
          {/* Enabled by the script: drawing needs it. */}
          <label className="embed-check">
            <input type="radio" name="kind" value="DRAWN" disabled />
            <span>{t('signing.page.drawn')}</span>
          </label>
        </fieldset>
        <div data-sign-drawn="" hidden>
          <p className="embed-muted">{t('signing.page.drawHint')}</p>
          <canvas className="sign-pad" width={600} height={200} data-sign-pad="" aria-label={t('signing.page.drawn')} />
          <p>
            <button type="button" className="sign-secondary" data-sign-clear="">
              {t('signing.page.clear')}
            </button>
          </p>
        </div>
        <label className="embed-check">
          <input type="checkbox" name="consent" value="yes" required />
          <span>{t('signing.page.consent')}</span>
        </label>
        <button type="submit" className="embed-button">
          {t('signing.page.sign')}
        </button>
      </form>
    </Document>,
  );
}

/** A request the signer cannot sign now: signed already, complete, waiting for earlier signers, or closed. */
export function renderSigningState(props: {
  lang: string;
  t: Translate;
  model: SigningPageModel;
  documentHref: string | null;
  signedHref: string | null;
}): string {
  const { t, model } = props;
  const key = {
    OPEN: 'signed',
    SIGNED: 'signed',
    COMPLETED: 'completed',
    WAITING: 'waiting',
    CLOSED: 'closed',
  }[model.state];
  const title = t(`signing.page.${key}Title`);
  return page(
    <Document lang={props.lang} title={title} agency={model.agencyName}>
      <h1 className="embed-h1">{title}</h1>
      <p className="embed-notice">{t(`signing.page.${key}`)}</p>
      {model.state === 'CLOSED' ? null : <Summary t={t} model={model} documentHref={props.documentHref} />}
      {model.state === 'COMPLETED' && model.signedSha256 ? (
        <section>
          <dl className="embed-facts-list">
            <dt>{t('signing.page.signedHash')}</dt>
            <dd className="sign-hash">{model.signedSha256}</dd>
          </dl>
          {props.signedHref ? (
            <p>
              <a className="embed-link" href={props.signedHref} target="_blank" rel="noopener noreferrer">
                {t('signing.page.downloadSigned')}
              </a>
            </p>
          ) : null}
        </section>
      ) : null}
    </Document>,
  );
}

/** A neutral page for an invalid link or too many requests: no branding, nothing about any agency or signer. */
export function renderSigningRefused(props: { lang: string; t: Translate; limited?: boolean }): string {
  const { t } = props;
  const title = props.limited ? t('signing.page.limited') : t('signing.page.goneTitle');
  return page(
    <Document lang={props.lang} title={title} agency={null}>
      <h1 className="embed-h1">{title}</h1>
      {props.limited ? null : <p className="embed-muted">{t('signing.page.gone')}</p>}
    </Document>,
  );
}
