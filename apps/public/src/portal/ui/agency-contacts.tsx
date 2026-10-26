import type { PortalAgency } from '@inmolink/core/modules/website-api';
import type { getTranslations } from 'next-intl/server';
import { EXTERNAL_REL, mailtoHref, safeHttpUrl } from '../urls';

type T = Awaited<ReturnType<typeof getTranslations<'portal'>>>;

/**
 * An agency's published contact details as actions (S15-01; shared with the profile page since S15-03): call, e-mail
 * (a plain address only, `mailtoHref`), its website (http(s) only, `safeHttpUrl`; never `javascript:` / `data:`).
 */
export function AgencyContacts(props: {
  agency: Pick<PortalAgency, 'phone' | 'email' | 'website'>;
  /** The e-mail subject. */
  subject: string;
  t: T;
  className?: string;
}) {
  const { agency, t } = props;
  const website = safeHttpUrl(agency.website);
  const mailto = mailtoHref(agency.email, props.subject);
  return (
    <ul className={`grid gap-2 text-sm ${props.className ?? ''}`}>
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
  );
}
