/** @jsxImportSource @/embed/html */
import type { WebsiteCard, WebsiteDetail, WebsiteImage } from '@inmolink/contracts';
import type { EmbedBranding } from '@inmolink/core/modules/website-api';
import type { Formatter } from '@inmolink/i18n';
import type { Translate } from '@inmolink/i18n/server';
import type { HtmlNode } from './html/jsx-runtime';

/**
 * Embed page views (S7-F8): presentation only, from what the website API read path served (white-labelled documents,
 * the checked branding). Rendered by the embed HTML runtime (`html/jsx-runtime.ts`) to static markup: every text is
 * escaped; no HTML from data, ever.
 */

/** Widths of the media pipeline's WebP variants (longest side; `media/variants.ts`). */
const VARIANT_WIDTHS = { thumb: 320, small: 640, medium: 1280, large: 2048 } as const;

function srcSet(image: WebsiteImage): string | undefined {
  const parts = (Object.keys(VARIANT_WIDTHS) as (keyof typeof VARIANT_WIDTHS)[])
    .filter((k) => image.urls[k])
    .map((k) => `${image.urls[k]} ${VARIANT_WIDTHS[k]}w`);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

// S12-04: shared with the selection pages.
export function Picture(props: {
  image: WebsiteImage;
  alt: string;
  sizes: string;
  eager?: boolean;
  className?: string;
}) {
  const src = props.image.urls.medium ?? props.image.urls.small ?? props.image.urls.large ?? props.image.urls.thumb;
  if (!src) return null;
  return (
    // biome-ignore lint/performance/noImgElement: CDN variants with srcset; next/image would proxy them again.
    <img
      src={src}
      srcSet={srcSet(props.image)}
      sizes={props.sizes}
      alt={props.alt}
      width={props.image.width}
      height={props.image.height}
      loading={props.eager ? 'eager' : 'lazy'}
      fetchPriority={props.eager ? 'high' : undefined}
      // The LCP image decodes with the page, not after it (perf review); the rest decode off the main thread.
      decoding={props.eager ? undefined : 'async'}
      className={props.className}
    />
  );
}

/**
 * `sizes` capped so a phone takes the 640w variant, not 1280w (perf review: no 960w variant exists): a 412 px screen at
 * DPR 1.75 needs 630 px for 360 CSS px.
 */
export const HERO_SIZES = '(min-width: 960px) 900px, (min-width: 480px) 100vw, 360px';
export const CARD_SIZES = '(min-width: 640px) 300px, 360px';

export interface ViewText {
  t: Translate;
  fmt: Formatter;
}

export function priceText(price: WebsiteCard['price'], { t, fmt }: ViewText): string {
  if (price.onRequest || price.amountCents === null) return t('card.onRequest');
  const amount = fmt.money(price.amountCents, price.currency);
  return price.period ? t(`card.perPeriod.${price.period}`, { price: amount }) : amount;
}

export function placeText(place: WebsiteCard['place']): string {
  return [place.area?.name, place.city?.name, place.region?.name].filter(Boolean).join(', ');
}

export function facts(item: WebsiteCard | WebsiteDetail, { t, fmt }: ViewText): string[] {
  const out: string[] = [];
  if (item.bedrooms !== null) out.push(t('card.beds', { count: item.bedrooms }));
  if (item.bathrooms !== null) out.push(t('card.baths', { count: item.bathrooms }));
  const built = item.kind === 'LISTING' ? item.builtM2 : item.internalM2;
  if (built !== null) out.push(t('card.built', { area: fmt.area(built) }));
  if (item.plotM2 !== null) out.push(t('card.plot', { area: fmt.area(item.plotM2) }));
  return out;
}

const cover = (item: WebsiteCard | WebsiteDetail): WebsiteImage | null => (item.kind === 'LISTING' ? item.cover : null);

export function EmbedCard({
  item,
  href,
  text,
  eager,
}: {
  item: WebsiteCard;
  href: string;
  text: ViewText;
  /** Above the fold (the first cards): loaded at once, the first with high priority (the search page's LCP). */
  eager?: boolean;
}) {
  const image = cover(item);
  return (
    <li className="embed-card">
      <a href={href} className="embed-card-link">
        <div className="embed-card-media">
          {image ? (
            <Picture image={image} alt={image.alt ?? item.title} sizes={CARD_SIZES} eager={eager} />
          ) : (
            <span className="embed-muted">{text.t('card.noPhoto')}</span>
          )}
        </div>
        <div className="embed-card-body">
          <p className="embed-price">{priceText(item.price, text)}</p>
          <h2 className="embed-card-title">{item.title}</h2>
          <p className="embed-muted">{placeText(item.place)}</p>
          <p className="embed-facts">{facts(item, text).join(' · ')}</p>
          <p className="embed-muted embed-small">{text.t('card.ref', { ref: item.ref })}</p>
        </div>
      </a>
    </li>
  );
}

export function EmbedContact({ branding, t }: { branding: EmbedBranding; t: Translate }) {
  return (
    <section className="embed-panel" aria-labelledby="embed-contact">
      <h2 id="embed-contact" className="embed-h2">
        {t('contact.title', { agency: branding.name })}
      </h2>
      <dl className="embed-contact">
        {branding.phone ? (
          <>
            <dt>{t('contact.phone')}</dt>
            <dd>
              <a href={`tel:${branding.phone.replace(/[^+0-9]/g, '')}`}>{branding.phone}</a>
            </dd>
          </>
        ) : null}
        {branding.email ? (
          <>
            <dt>{t('contact.email')}</dt>
            <dd>
              <a href={`mailto:${branding.email}`}>{branding.email}</a>
            </dd>
          </>
        ) : null}
        {branding.whatsapp ? (
          <>
            <dt>{t('contact.whatsapp')}</dt>
            <dd>
              <a href={`https://wa.me/${branding.whatsapp}`} target="_blank" rel="noopener noreferrer">
                +{branding.whatsapp}
              </a>
            </dd>
          </>
        ) : null}
        {branding.website ? (
          <>
            <dt>{t('contact.website')}</dt>
            <dd>
              <a href={branding.website} target="_blank" rel="noopener noreferrer">
                {new URL(branding.website).hostname}
              </a>
            </dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

/** The detail page body: gallery, facts, description, features, the presenting agency's contacts and the form. */
export function EmbedDetailView(props: {
  detail: WebsiteDetail;
  branding: EmbedBranding;
  backHref: string;
  text: ViewText;
  /** The enquiry form (`EmbedLeadForm`), or the reason there is none. */
  form?: HtmlNode;
}) {
  const { detail, branding, text } = props;
  const { t } = text;
  const images = (detail.kind === 'LISTING' ? detail.media : []).filter((m): m is WebsiteImage => m.kind !== 'VIDEO');
  const first = cover(detail) ?? images[0] ?? null;
  const key = (m: WebsiteImage) => m.urls.medium ?? m.urls.small ?? m.urls.large ?? m.urls.thumb;
  const rest = images.filter((m) => !first || key(m) !== key(first)).slice(0, 11);
  const type = detail.propertyType.name;
  const features = detail.kind === 'LISTING' ? detail.features : [];
  const energy = detail.kind === 'LISTING' ? detail.energyRating : null;
  return (
    <article className="embed-detail">
      <p>
        <a href={props.backHref} className="embed-link">
          {t('detail.back')}
        </a>
      </p>
      <h1 className="embed-h1">{detail.title}</h1>
      <p className="embed-price embed-price-lg">{priceText(detail.price, text)}</p>
      {first ? (
        <div className="embed-hero">
          <Picture image={first} alt={first.alt ?? detail.title} sizes={HERO_SIZES} eager />
        </div>
      ) : null}
      {rest.length > 0 ? (
        <section aria-label={t('detail.photos')}>
          <ul className="embed-thumbs">
            {rest.map((m, i) => (
              <li key={m.urls.thumb ?? m.urls.small ?? i}>
                <Picture
                  image={m}
                  alt={m.alt ?? t('detail.photo', { n: i + 2, total: rest.length + 1 })}
                  sizes="160px"
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="embed-panel" aria-labelledby="embed-facts">
        <h2 id="embed-facts" className="embed-h2">
          {t('detail.facts')}
        </h2>
        <dl className="embed-facts-list">
          <dt>{t('detail.type')}</dt>
          <dd>{type}</dd>
          <dt>{t('detail.location')}</dt>
          <dd>{placeText(detail.place)}</dd>
          {energy ? (
            <>
              <dt>{t('detail.energy')}</dt>
              <dd>{energy}</dd>
            </>
          ) : null}
          <dt>{t('detail.ref')}</dt>
          <dd>{detail.ref}</dd>
        </dl>
        <p className="embed-facts">{facts(detail, text).join(' · ')}</p>
      </section>
      {detail.description ? (
        <section className="embed-panel" aria-labelledby="embed-description">
          <h2 id="embed-description" className="embed-h2">
            {t('detail.description')}
          </h2>
          {detail.description.split(/\n{2,}/).map((p, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the paragraphs of one text, never reordered.
            <p key={i} className="embed-text">
              {p}
            </p>
          ))}
        </section>
      ) : null}
      {features.length > 0 ? (
        <section className="embed-panel" aria-labelledby="embed-features">
          <h2 id="embed-features" className="embed-h2">
            {t('detail.features')}
          </h2>
          <ul className="embed-features">
            {features.map((f) => (
              <li key={f.id}>{f.name}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <EmbedContact branding={branding} t={t} />
      {props.form}
    </article>
  );
}
