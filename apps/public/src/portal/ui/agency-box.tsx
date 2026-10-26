import type { PortalAgency } from '@inmolink/core/modules/website-api';
import type { getTranslations } from 'next-intl/server';
import { agencyPath, EXTERNAL_REL, mailtoHref, safeHttpUrl } from '../urls';

type T = Awaited<ReturnType<typeof getTranslations<'portal'>>>;

/**
 * The listing agency beside a listing or development (S15-01): its published name and contact details and its profile
 * (S15-03). The enquiry form joins it in S15-02. Only an http(s) website becomes a link (never `javascript:` / `data:`).
 */
export function AgencyBox(props: {
  locale: string;
  agency: PortalAgency | null;
  /** The e-mail subject: what the visitor asks about. */
  subject: string;
  /** The reference to quote. */
  reference: string;
  t: T;
}) {
  const { agency, t } = props;
  const website = safeHttpUrl(agency?.website);
  const mailto = mailtoHref(agency?.email, props.subject);
  const profile = agency ? agencyPath(props.locale, agency) : null;
  return (
    <aside aria-labelledby="agency" className="lg:sticky lg:top-6 lg:self-start">
      <div className="rounded-lg border border-shore p-5">
        <h2 id="agency" className="text-sm font-semibold text-stone">
          {t('listing.agency')}
        </h2>
        {agency ? (
          <>
            <p className="mt-1 text-lg font-bold">
              {profile ? (
                <a href={profile} className="text-ink hover:text-sea">
                  {agency.name}
                </a>
              ) : (
                agency.name
              )}
            </p>
            <ul className="mt-4 grid gap-2 text-sm">
              {agency.phone ? (
                <li>
                  <a
                    href={`tel:${agency.phone.replace(/[^\d+]/g, '')}`}
                    className="block rounded-md bg-sea px-4 py-2 text-center font-semibold text-white hover:bg-sea-deep"
                  >
                    {t('listing.call')} {agency.phone}
                  </a>
                </li>
              ) : null}
              {mailto ? (
                <li>
                  <a
                    href={mailto}
                    className="block rounded-md border border-sea px-4 py-2 text-center font-semibold text-sea hover:bg-shore"
                  >
                    {t('listing.email')}
                  </a>
                </li>
              ) : null}
              {website ? (
                <li>
                  <a href={website} rel={EXTERNAL_REL} className="text-sea hover:underline">
                    {t('listing.website')}
                  </a>
                </li>
              ) : null}
            </ul>
            <p className="mt-4 text-xs text-stone">{t('listing.contactHint', { ref: props.reference })}</p>
            {profile ? (
              <p className="mt-3 text-sm">
                <a href={profile} className="text-sea hover:underline">
                  {t('listing.agencyProfile', { agency: agency.name })}
                </a>
              </p>
            ) : null}
          </>
        ) : (
          <p className="mt-2 text-sm text-stone">{t('listing.unlisted')}</p>
        )}
      </div>
    </aside>
  );
}
