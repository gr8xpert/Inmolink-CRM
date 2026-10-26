import type { WebsiteImage } from '@inmolink/contracts';
import type { PortalListing } from '@inmolink/core/modules/website-api';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { formatter } from '@inmolink/i18n';
import { getTranslations } from 'next-intl/server';
import type { PortalSettings } from '../data';
import type { Crumb } from '../seo';
import { developmentPath, listingPath } from '../urls';
import { AgencyBox } from './agency-box';
import { Breadcrumbs } from './breadcrumbs';
import { EnquiryForm } from './enquiry-form';
import { MapToggle } from './map-toggle';
import { HERO_SIZES, Photo, THUMB_SIZES } from './picture';
import { factsOf, priceOf, townOf } from './results';

/** Photos shown in the opening grid; the rest open under "See all photos" (loaded only then). */
const GRID_PHOTOS = 3;

const imagesOf = (l: PortalListing): WebsiteImage[] =>
  l.detail.media.filter((m): m is WebsiteImage => m.kind !== 'VIDEO' && m.kind !== 'FLOOR_PLAN');

/**
 * A listing page's body (S15-01): title and price over a photo grid, then the description, features and key facts
 * beside the listing agency (its published contact details and profile) and the enquiry form (S15-02).
 */
export async function ListingView(props: {
  locale: string;
  listing: PortalListing;
  title: string;
  crumbs: readonly Crumb[];
  settings: PortalSettings;
}) {
  const t = await getTranslations({ locale: props.locale, namespace: 'portal' });
  const fmt = formatter(props.locale);
  const { detail, agency } = props.listing;
  const images = imagesOf(props.listing);
  const cover = detail.cover ?? images[0] ?? null;
  const rest = images.filter((i) => i !== cover && i.urls.medium !== cover?.urls.medium);
  const town = townOf(detail.place);
  const alt = (n: number) => t('listing.photoAlt', { n, type: detail.propertyType.name, town });
  const facts = factsOf(t, props.locale, detail, detail.terraceM2);
  const money = (cents: number | null, key: 'perMonth' | 'perYear') =>
    cents === null ? null : t(`listing.${key}`, { amount: fmt.money(cents, detail.price.currency) });
  const rows: [string, string | null][] = [
    [t('listing.reference'), detail.ref],
    [t('listing.price'), priceOf(t, props.locale, detail.price)],
    [t('listing.type'), detail.propertyType.name],
    [
      t('listing.location'),
      [detail.place.area?.name, detail.place.city?.name, detail.place.region?.name].filter(Boolean).join(', ') || null,
    ],
    [t('listing.bedrooms'), detail.bedrooms === null ? null : fmt.number(detail.bedrooms)],
    [t('listing.bathrooms'), detail.bathrooms === null ? null : fmt.number(detail.bathrooms)],
    [t('listing.built'), detail.builtM2 ? fmt.area(detail.builtM2) : null],
    [t('listing.plot'), detail.plotM2 ? fmt.area(detail.plotM2) : null],
    [t('listing.terrace'), detail.terraceM2 ? fmt.area(detail.terraceM2) : null],
    [t('listing.yearBuilt'), detail.yearBuilt === null ? null : String(detail.yearBuilt)],
    [t('listing.energy'), detail.energyRating],
    [t('listing.communityFee'), money(detail.communityFeeMonthCents, 'perMonth')],
    [t('listing.ibi'), money(detail.ibiYearCents, 'perYear')],
    [t('listing.garbage'), money(detail.garbageTaxYearCents, 'perYear')],
  ];
  const pin =
    props.settings.map && detail.geo ? [{ lat: detail.geo.lat, lng: detail.geo.lng, label: props.title }] : [];
  return (
    <div className="mx-auto max-w-6xl px-4 pt-6">
      <Breadcrumbs label={t('breadcrumb.label')} crumbs={props.crumbs} />
      <header className="mt-4 flex flex-wrap items-end justify-between gap-x-8 gap-y-2">
        <div>
          <h1 className="text-[clamp(1.75rem,4.5vw,3rem)] font-extrabold leading-tight tracking-tight">
            {props.title}
          </h1>
          {facts.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-stone">
              {facts.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <p className="text-[clamp(1.5rem,3.5vw,2.25rem)] font-extrabold tabular-nums tracking-tight text-sea-deep">
          {priceOf(t, props.locale, detail.price)}
        </p>
      </header>

      {cover ? (
        <section aria-label={t('listing.photos')} className="mt-6">
          <div className="grid gap-2 lg:grid-cols-[2fr_1fr]">
            <div className="aspect-[4/3] overflow-hidden rounded-md bg-shore lg:aspect-auto lg:h-[28rem]">
              <Photo image={cover} alt={alt(1)} sizes={HERO_SIZES} eager className="h-full w-full object-cover" />
            </div>
            {rest.length > 0 ? (
              <div className="hidden gap-2 lg:grid lg:grid-rows-2">
                {rest.slice(0, GRID_PHOTOS - 1).map((img, i) => (
                  <div key={img.urls.medium ?? i} className="overflow-hidden rounded-md bg-shore">
                    <Photo image={img} alt={alt(i + 2)} sizes={THUMB_SIZES} className="h-full w-full object-cover" />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          {rest.length > 0 ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-semibold text-sea">
                {t('listing.allPhotos', { n: images.length })}
              </summary>
              <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {rest.map((img, i) => (
                  <li key={img.urls.medium ?? i} className="aspect-[4/3] overflow-hidden rounded-md bg-shore">
                    <Photo image={img} alt={alt(i + 2)} sizes={THUMB_SIZES} className="h-full w-full object-cover" />
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}

      <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid gap-10">
          {detail.description ? (
            <section aria-labelledby="about">
              <h2 id="about" className="text-xl font-bold">
                {t('listing.description')}
              </h2>
              <p className="mt-3 max-w-[70ch] whitespace-pre-line leading-relaxed text-ink">{detail.description}</p>
            </section>
          ) : null}
          {props.listing.developmentCode ? (
            <p className="rounded-md bg-foam px-4 py-3 text-sm">
              {t('development.fromListing')}{' '}
              <a
                href={developmentPath(props.locale, 'development', props.listing.developmentCode)}
                className="font-semibold text-sea hover:underline"
              >
                {t('development.seeDevelopment')}
              </a>
            </p>
          ) : null}
          {detail.features.length > 0 ? (
            <section aria-labelledby="features">
              <h2 id="features" className="text-xl font-bold">
                {t('listing.features')}
              </h2>
              <ul className="mt-3 columns-2 gap-6 text-sm sm:columns-3">
                {detail.features.map((f) => (
                  <li key={f.id} className="mb-1.5 break-inside-avoid">
                    {f.name}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section aria-labelledby="facts">
            <h2 id="facts" className="text-xl font-bold">
              {t('listing.facts')}
            </h2>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-8 gap-y-2 text-sm sm:max-w-xl">
              {rows
                .filter((r): r is [string, string] => r[1] !== null && r[1] !== '')
                .map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-stone">{k}</dt>
                    <dd className="font-medium tabular-nums">{v}</dd>
                  </div>
                ))}
            </dl>
          </section>
          {pin.length > 0 && props.settings.map ? (
            <section aria-labelledby="where">
              <h2 id="where" className="mb-3 text-xl font-bold">
                {t('listing.where')}
              </h2>
              <MapToggle
                pins={pin}
                tileUrl={props.settings.map.tileUrl}
                attribution={props.settings.map.attribution}
                text={{
                  show: t('map.show'),
                  hide: t('map.hide'),
                  label: t('map.listingLabel'),
                  zoomIn: t('map.zoomIn'),
                  zoomOut: t('map.zoomOut'),
                  note: detail.geo?.precision === 'EXACT' ? undefined : t('map.approximate'),
                }}
              />
            </section>
          ) : null}
        </div>
        <AgencyBox
          locale={props.locale}
          agency={agency}
          subject={`${props.title} (${detail.ref})`}
          reference={detail.ref}
          t={t}
        >
          {agency ? (
            <EnquiryForm
              locale={props.locale}
              about={{ code: props.listing.code }}
              back={props.listing.paths[props.locale] ?? listingPath(props.locale, props.title, props.listing.code)}
              agency={agency.name}
              messageDefault={t('enquiry.messageDefault', { ref: detail.ref })}
              turnstileSiteKey={props.settings.turnstileSiteKey}
              turnstileAction={websiteApi.LEAD_TURNSTILE_ACTION}
              t={t as (key: string, values?: Record<string, string>) => string}
            />
          ) : null}
        </AgencyBox>
      </div>
    </div>
  );
}
