import type { PortalQuery } from '@inmolink/contracts';
import { PORTAL_BUILD_STEPS, PORTAL_FEATURES, PORTAL_PRICE_STEPS, PORTAL_ROOM_STEPS } from '@inmolink/contracts';
import type { PortalCatalog } from '@inmolink/core/modules/website-api';
import { formatter } from '@inmolink/i18n';
import { getTranslations } from 'next-intl/server';
import { hasFilters } from '../urls';

/**
 * The search filters (S15-01, the legacy portal's set): a plain GET form — no script — that reloads the same page with
 * the filters in the query string (`PortalQuery`). Price, bedrooms and type up front; bathrooms, built size and
 * features under "More filters". The sort carries over; the page resets.
 */
export async function Filters(props: { locale: string; path: string; query: PortalQuery; catalog: PortalCatalog }) {
  const t = await getTranslations({ locale: props.locale, namespace: 'portal' });
  const fmt = formatter(props.locale);
  const q = props.query;
  const euro = (n: number) => fmt.money(n * 100, 'EUR');
  const select = 'w-full rounded-md border border-mist bg-white px-2 py-2 text-sm text-ink';
  const label = 'mb-1 block text-xs font-semibold text-stone';
  const moreOpen =
    q.bathrooms_min !== undefined || q.bathrooms_max !== undefined || q.build_min !== undefined || q.feature.length > 0;
  const features = PORTAL_FEATURES.filter((f) => props.catalog.features[f]);
  const typeCount = q.type.length;
  // The offered groups, plus any group of a type the visitor has chosen (a link may name one past the offered few).
  const offered = new Set(props.catalog.filterGroups.map((g) => g.id));
  const groups = [
    ...props.catalog.filterGroups,
    ...props.catalog.typeGroups.filter(
      (g) => !offered.has(g.id) && (q.type.includes(g.slug) || g.types.some((ty) => q.type.includes(ty.slug))),
    ),
  ];
  const active = hasFilters({ ...q, sort: undefined });
  return (
    // Phones: the form folds behind a toggle (pure CSS, no script) so the first results — and the page's largest image —
    // sit in the first screen; from `lg` it is the sidebar.
    <div>
      <input id="f-toggle" type="checkbox" className="peer sr-only" aria-controls="filters" />
      <label
        htmlFor="f-toggle"
        className="flex cursor-pointer items-center justify-between rounded-md border border-mist px-4 py-2 text-sm font-semibold peer-focus-visible:outline-3 peer-focus-visible:outline-sea lg:hidden"
      >
        {t('filters.title')}
        {active ? <span className="text-stone">({t('filters.active')})</span> : null}
      </label>
      <form
        id="filters"
        method="get"
        action={props.path}
        className="mt-3 hidden gap-4 rounded-lg bg-foam p-4 peer-checked:grid lg:mt-0 lg:grid"
        aria-label={t('filters.title')}
      >
        <h2 className="text-base font-bold">{t('filters.title')}</h2>
        {q.sort && q.sort !== 'latest' ? <input type="hidden" name="sort" value={q.sort} /> : null}
        <fieldset className="grid grid-cols-2 gap-2">
          <legend className="mb-1 text-sm font-semibold">{t('filters.price')}</legend>
          <div>
            <label htmlFor="f-price-min" className={label}>
              {t('filters.priceMin')}
            </label>
            <select id="f-price-min" name="price_min" defaultValue={q.price_min ?? ''} className={select}>
              <option value="">{t('filters.noMin')}</option>
              {PORTAL_PRICE_STEPS.map((p) => (
                <option key={p} value={p}>
                  {euro(p)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="f-price-max" className={label}>
              {t('filters.priceMax')}
            </label>
            <select id="f-price-max" name="price_max" defaultValue={q.price_max ?? ''} className={select}>
              <option value="">{t('filters.noMax')}</option>
              {PORTAL_PRICE_STEPS.map((p) => (
                <option key={p} value={p}>
                  {euro(p)}
                </option>
              ))}
            </select>
          </div>
        </fieldset>
        <RoomRange
          legend={t('filters.bedrooms')}
          id="beds"
          names={['bedrooms_min', 'bedrooms_max']}
          values={[q.bedrooms_min, q.bedrooms_max]}
          text={{ min: t('filters.min'), max: t('filters.max'), any: t('filters.any') }}
          className={{ select, label }}
        />
        <details className="group rounded-md border border-shore bg-white" open={typeCount > 0}>
          <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">
            {t('filters.type')}
            {typeCount > 0 ? <span className="ml-1 text-stone">({typeCount})</span> : null}
          </summary>
          <div className="grid gap-3 px-3 pb-3">
            {groups.map((g) => (
              <fieldset key={g.id}>
                <legend className="text-xs font-semibold text-stone">{g.name}</legend>
                <ul className="mt-1 grid grid-cols-2 gap-x-2 gap-y-1">
                  {g.types.map((ty) => (
                    <li key={ty.id}>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name="type"
                          value={ty.slug}
                          defaultChecked={q.type.includes(ty.slug) || q.type.includes(g.slug)}
                          className="size-4 accent-sea"
                        />
                        {ty.name}
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            ))}
          </div>
        </details>
        <details className="rounded-md border border-shore bg-white" open={moreOpen}>
          <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">{t('filters.more')}</summary>
          <div className="grid gap-4 px-3 pb-3">
            <RoomRange
              legend={t('filters.bathrooms')}
              id="baths"
              names={['bathrooms_min', 'bathrooms_max']}
              values={[q.bathrooms_min, q.bathrooms_max]}
              text={{ min: t('filters.min'), max: t('filters.max'), any: t('filters.any') }}
              className={{ select, label }}
            />
            <div>
              <label htmlFor="f-build-min" className={label}>
                {t('filters.buildMin')}
              </label>
              <select id="f-build-min" name="build_min" defaultValue={q.build_min ?? ''} className={select}>
                <option value="">{t('filters.any')}</option>
                {PORTAL_BUILD_STEPS.map((m) => (
                  <option key={m} value={m}>
                    {fmt.area(m)}
                  </option>
                ))}
              </select>
            </div>
            {features.length > 0 ? (
              <fieldset>
                <legend className="mb-1 text-sm font-semibold">{t('filters.features')}</legend>
                <ul className="flex flex-wrap gap-x-4 gap-y-1">
                  {features.map((f) => (
                    <li key={f}>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name="feature"
                          value={f}
                          defaultChecked={q.feature.includes(f)}
                          className="size-4 accent-sea"
                        />
                        {t(`filters.feature.${f}`)}
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            ) : null}
          </div>
        </details>
        <div className="flex items-center justify-between gap-3">
          <button
            type="submit"
            className="rounded-md bg-sea px-4 py-2 text-sm font-semibold text-white hover:bg-sea-deep"
          >
            {t('filters.apply')}
          </button>
          <a href={props.path} className="text-sm text-sea hover:underline">
            {t('filters.clear')}
          </a>
        </div>
      </form>
    </div>
  );
}

function RoomRange(props: {
  legend: string;
  id: string;
  names: [string, string];
  values: [number | undefined, number | undefined];
  text: { min: string; max: string; any: string };
  className: { select: string; label: string };
}) {
  return (
    <fieldset className="grid grid-cols-2 gap-2">
      <legend className="mb-1 text-sm font-semibold">{props.legend}</legend>
      {(['min', 'max'] as const).map((end, i) => (
        <div key={end}>
          <label htmlFor={`f-${props.id}-${end}`} className={props.className.label}>
            {props.text[end]}
          </label>
          <select
            id={`f-${props.id}-${end}`}
            name={props.names[i]}
            defaultValue={props.values[i] ?? ''}
            className={props.className.select}
          >
            <option value="">{props.text.any}</option>
            {PORTAL_ROOM_STEPS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      ))}
    </fieldset>
  );
}
