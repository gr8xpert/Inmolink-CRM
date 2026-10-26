import type { PortalDevelopment } from '@inmolink/core/modules/website-api';
import { formatter } from '@inmolink/i18n';
import { getTranslations } from 'next-intl/server';
import type { Crumb } from '../seo';
import { AgencyBox } from './agency-box';
import { Breadcrumbs } from './breadcrumbs';
import { townOf } from './results';

/**
 * A new-build development's page (S15-01): its name, status and completion over the price and bedroom ranges and the
 * homes left, its description and payment terms, the table of its available and reserved homes in the developer's
 * order, and the listing agency. All from the units' read models (the representative unit carries the development's
 * texts); no photos in R1 (developments have none of their own in the read models yet).
 */
export async function DevelopmentView(props: {
  locale: string;
  development: PortalDevelopment;
  title: string;
  crumbs: readonly Crumb[];
}) {
  const t = await getTranslations({ locale: props.locale, namespace: 'portal' });
  const fmt = formatter(props.locale);
  const { detail, agency, units } = props.development;
  const money = (cents: number) => fmt.money(cents, detail.price.currency);
  const price =
    detail.price.fromCents === null
      ? null
      : detail.price.toCents !== null && detail.price.toCents !== detail.price.fromCents
        ? t('development.priceRange', { from: money(detail.price.fromCents), to: money(detail.price.toCents) })
        : t('development.priceFrom', { from: money(detail.price.fromCents) });
  const beds =
    detail.bedrooms.min === null
      ? null
      : detail.bedrooms.max !== null && detail.bedrooms.max !== detail.bedrooms.min
        ? t('development.bedroomsRange', { min: detail.bedrooms.min, max: detail.bedrooms.max })
        : t('development.bedroomsOne', { n: detail.bedrooms.min });
  const completion = detail.completionDate
    ? t('development.completion', {
        date: fmt.date(new Date(`${detail.completionDate}T00:00:00Z`), { month: 'long', year: 'numeric' }),
      })
    : null;
  const area = (m2: number | null) => (m2 ? fmt.area(m2) : '');
  return (
    <div className="mx-auto max-w-6xl px-4 pt-6">
      <Breadcrumbs label={t('breadcrumb.label')} crumbs={props.crumbs} />
      <header className="mt-4 border-b border-shore pb-8">
        <p className="text-sm font-semibold text-pine">
          {t(`development.developmentStatus.${detail.status}`)}
          {completion ? <span className="ml-3 font-normal text-stone">{completion}</span> : null}
        </p>
        <h1 className="mt-2 max-w-[24ch] text-[clamp(1.75rem,4.5vw,3rem)] font-extrabold leading-tight tracking-tight">
          {props.title}
        </h1>
        <p className="mt-1 text-stone">{townOf(detail.place)}</p>
        <dl className="mt-6 flex flex-wrap gap-x-10 gap-y-3">
          {price ? (
            <div>
              <dt className="text-xs text-stone">{t('development.price')}</dt>
              <dd className="text-2xl font-extrabold tabular-nums tracking-tight text-sea-deep">{price}</dd>
            </div>
          ) : null}
          {beds ? (
            <div>
              <dt className="text-xs text-stone">{t('development.bedrooms')}</dt>
              <dd className="text-2xl font-bold">{beds}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-xs text-stone">{t('development.units')}</dt>
            <dd className="text-2xl font-bold">
              {t('development.unitsSummary', {
                available: detail.units.available,
                reserved: detail.units.reserved,
              })}
            </dd>
          </div>
        </dl>
      </header>

      <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid min-w-0 gap-10">
          {detail.description ? (
            <section aria-labelledby="about">
              <h2 id="about" className="text-xl font-bold">
                {t('development.description')}
              </h2>
              <p className="mt-3 max-w-[70ch] whitespace-pre-line leading-relaxed">{detail.description}</p>
            </section>
          ) : null}
          {detail.paymentTerms ? (
            <section aria-labelledby="terms">
              <h2 id="terms" className="text-xl font-bold">
                {t('development.paymentTerms')}
              </h2>
              <p className="mt-3 max-w-[70ch] whitespace-pre-line leading-relaxed">{detail.paymentTerms}</p>
            </section>
          ) : null}
          {units.length > 0 ? (
            <section aria-labelledby="units">
              <h2 id="units" className="text-xl font-bold">
                {t('development.units')}
              </h2>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
                  <caption className="sr-only">{t('development.unitsCaption')}</caption>
                  <thead className="border-b border-ink/20 text-xs text-stone">
                    <tr>
                      <th scope="col" className="py-2 pr-4 font-semibold">
                        {t('development.unit')}
                      </th>
                      <th scope="col" className="py-2 pr-4 font-semibold">
                        {t('development.bedrooms')}
                      </th>
                      <th scope="col" className="py-2 pr-4 font-semibold">
                        {t('development.bathrooms')}
                      </th>
                      <th scope="col" className="py-2 pr-4 font-semibold">
                        {t('development.size')}
                      </th>
                      <th scope="col" className="py-2 pr-4 font-semibold">
                        {t('development.terrace')}
                      </th>
                      <th scope="col" className="py-2 pr-4 font-semibold">
                        {t('development.floor')}
                      </th>
                      <th scope="col" className="py-2 pr-4 text-right font-semibold">
                        {t('development.price')}
                      </th>
                      <th scope="col" className="py-2 font-semibold">
                        {t('development.status')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-shore">
                    {units.map((u) => (
                      <tr key={u.id}>
                        <th scope="row" className="py-2 pr-4 font-medium">
                          {u.propertyType.name} <span className="text-xs text-stone">{u.ref}</span>
                        </th>
                        <td className="py-2 pr-4 tabular-nums">{u.bedrooms ?? ''}</td>
                        <td className="py-2 pr-4 tabular-nums">{u.bathrooms ?? ''}</td>
                        <td className="py-2 pr-4 tabular-nums">{area(u.internalM2)}</td>
                        <td className="py-2 pr-4 tabular-nums">{area(u.terraceM2)}</td>
                        <td className="py-2 pr-4 tabular-nums">{u.floor ?? ''}</td>
                        <td className="py-2 pr-4 text-right font-semibold tabular-nums">
                          {u.price.onRequest || u.price.amountCents === null
                            ? t('card.onRequest')
                            : money(u.price.amountCents)}
                        </td>
                        <td className={`py-2 ${u.status === 'RESERVED' ? 'text-stone' : 'text-pine'}`}>
                          {t(`development.unitStatus.${u.status}`)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {props.development.moreUnits ? (
                <p className="mt-3 text-sm text-stone">{t('development.moreUnits')}</p>
              ) : null}
            </section>
          ) : null}
        </div>
        <AgencyBox
          locale={props.locale}
          agency={agency}
          subject={`${props.title} (${detail.ref})`}
          reference={detail.ref}
          t={t}
        />
      </div>
    </div>
  );
}
