import type { PortalCatalog, PortalPlace } from '@inmolink/core/modules/website-api';
import { formatter } from '@inmolink/i18n';
import { getTranslations } from 'next-intl/server';

/** Segment colours of the inventory bar, by rank (the list beside it carries the same information as text). */
const SEGMENTS = ['bg-sea', 'bg-pine', 'bg-sun', 'bg-mist', 'bg-sea-deep', 'bg-stone'] as const;
/** Types named one by one; the rest share the last segment. */
const MAX_TYPES = 6;

export interface TypeShare {
  id: string;
  slug: string;
  name: string;
  count: number;
}

/** Live counts per property type, largest first (types without listings left out). */
export function typeShares(catalog: PortalCatalog, counts: Readonly<Record<string, number>>): TypeShare[] {
  return catalog.typeGroups
    .flatMap((g) => g.types)
    .map((ty) => ({ id: ty.id, slug: ty.slug, name: ty.name, count: counts[ty.id] ?? 0 }))
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * A location page's opening (S15-01, the legacy intro text made visible): the live mix of property types as one bar
 * whose segments are the market's shares — each type a link to its filtered search — and the places below this one
 * with their counts. Page 1 only; counts come from the search engine's facets (none while the fallback answers).
 */
export async function LocationIntro(props: {
  locale: string;
  path: string;
  intro: string;
  catalog: PortalCatalog;
  typeCounts: Readonly<Record<string, number>>;
  childrenHeading: string;
  places: readonly PortalPlace[];
  childHref: (p: PortalPlace) => string;
  locationCounts: Readonly<Record<string, number>>;
  /** Facet counts are known (engine answered): children without listings are left out. */
  counted: boolean;
}) {
  const t = await getTranslations({ locale: props.locale, namespace: 'portal' });
  const fmt = formatter(props.locale);
  const shares = typeShares(props.catalog, props.typeCounts);
  const named = shares.slice(0, MAX_TYPES);
  const total = shares.reduce((n, s) => n + s.count, 0);
  const children = props.counted
    ? props.places.filter((c) => (props.locationCounts[c.id] ?? 0) > 0)
    : [...props.places];
  return (
    <div className="mt-4 grid gap-8">
      <p className="max-w-[68ch] text-base leading-relaxed text-stone">{props.intro}</p>
      {named.length > 0 ? (
        <section aria-labelledby="by-type">
          <h2 id="by-type" className="mb-3 text-sm font-semibold text-stone">
            {t('location.byType')}
          </h2>
          <div aria-hidden="true" className="flex h-3 w-full overflow-hidden rounded-full bg-shore">
            {shares.map((s, i) => (
              <span
                key={s.id}
                className={SEGMENTS[Math.min(i, SEGMENTS.length - 1)]}
                style={{ width: `${(s.count / total) * 100}%` }}
              />
            ))}
          </div>
          <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
            {named.map((s, i) => (
              <li key={s.id} className="flex items-baseline gap-2">
                <span
                  aria-hidden="true"
                  className={`inline-block size-2.5 shrink-0 rounded-full ${SEGMENTS[Math.min(i, SEGMENTS.length - 1)]}`}
                />
                <a
                  href={`${props.path}?type=${encodeURIComponent(s.slug)}`}
                  className="text-sm text-ink hover:text-sea"
                  aria-label={t('location.typeCount', { type: s.name, count: s.count })}
                >
                  {s.name} <span className="font-semibold tabular-nums">{fmt.number(s.count)}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {children.length > 0 ? (
        <section aria-labelledby="places">
          <h2 id="places" className="mb-3 text-sm font-semibold text-stone">
            {props.childrenHeading}
          </h2>
          <ul className="columns-2 gap-6 sm:columns-3 lg:columns-4">
            {children.map((c) => {
              const n = props.locationCounts[c.id];
              return (
                <li key={c.id} className="mb-1.5 break-inside-avoid">
                  <a href={props.childHref(c)} className="text-sm text-sea hover:underline">
                    {c.name}
                  </a>
                  {n !== undefined ? (
                    <span className="ml-1.5 text-xs tabular-nums text-stone">{fmt.number(n)}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
