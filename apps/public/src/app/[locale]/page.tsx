import { portalMetadataFor } from '@inmolink/core/modules/website-api';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { assertPortalLocale, directoryOf, PORTAL_LOCALES, portalSettings } from '@/portal/data';
import { PortalShell } from '@/portal/ui/shell';
import { homePath, searchPath, zonePath } from '@/portal/urls';

/**
 * The portal's home (S15-01): one search entry and the regions and zones to browse. Rendered per request from the
 * cached taxonomy (no statement warm) and CDN-cached (next.config); never at build time (no database there).
 */
export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: string }> };

const pathsOf = () => Object.fromEntries(PORTAL_LOCALES.map((l) => [l, homePath(l)]));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  assertPortalLocale(locale);
  return portalMetadataFor({ kind: 'home', locale, origin: (await portalSettings()).origin });
}

export default async function HomePage({ params }: Props) {
  const { locale } = await params;
  assertPortalLocale(locale);
  setRequestLocale(locale);
  const [t, directory] = await Promise.all([getTranslations({ locale, namespace: 'portal' }), directoryOf(locale)]);
  return (
    <PortalShell locale={locale} alternates={pathsOf()}>
      <div className="mx-auto max-w-6xl px-4">
        <section className="border-b border-shore py-14 sm:py-20">
          <h1 className="max-w-[16ch] text-[clamp(2.25rem,7vw,4.5rem)] font-extrabold leading-[1.02] tracking-tight">
            {t('home.heading')}
          </h1>
          <p className="mt-5 max-w-[56ch] text-lg leading-relaxed text-stone">{t('home.lead')}</p>
          <a
            href={searchPath(locale)}
            className="mt-8 inline-block rounded-md bg-sea px-5 py-3 font-semibold text-white hover:bg-sea-deep"
          >
            {t('home.searchAll')}
          </a>
        </section>
        {directory.countries.map((c) => (
          <section key={c.place.id} aria-labelledby={`country-${c.place.id}`} className="py-10">
            <h2 id={`country-${c.place.id}`} className="text-xl font-bold">
              {t('home.regions')}:{' '}
              <a href={searchPath(locale, c.place.path)} className="text-sea hover:underline">
                {c.place.name}
              </a>
            </h2>
            <ul className="mt-4 columns-2 gap-6 sm:columns-3 lg:columns-4">
              {c.regions.map((r) => (
                <li key={r.id} className="mb-2 break-inside-avoid">
                  <a href={searchPath(locale, r.path)} className="text-ink hover:text-sea">
                    {r.name}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {directory.zones.length > 0 ? (
          <section aria-labelledby="zones" className="border-t border-shore py-10">
            <h2 id="zones" className="text-xl font-bold">
              {t('home.zones')}
            </h2>
            <ul className="mt-4 columns-2 gap-6 sm:columns-3 lg:columns-4">
              {directory.zones.map((z) => (
                <li key={z.slug} className="mb-2 break-inside-avoid">
                  <a href={zonePath(locale, z.slug)} className="text-ink hover:text-sea">
                    {z.name}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </PortalShell>
  );
}
