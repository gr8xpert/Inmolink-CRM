import type { PortalAgency } from '@inmolink/core/modules/website-api';
import type { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { agencyPath } from '../urls';
import { AgencyContacts } from './agency-contacts';

type T = Awaited<ReturnType<typeof getTranslations<'portal'>>>;

/**
 * The listing agency beside a listing or development (S15-01): its published name and contact details and its profile
 * (S15-03), and the enquiry form (S15-02, `children`). Only an http(s) website becomes a link (never `javascript:` /
 * `data:`).
 */
export function AgencyBox(props: {
  locale: string;
  agency: PortalAgency | null;
  /** The e-mail subject: what the visitor asks about. */
  subject: string;
  /** The reference to quote. */
  reference: string;
  t: T;
  /** S15-02: the enquiry form (listing pages), under the contact details. */
  children?: ReactNode;
}) {
  const { agency, t } = props;
  return (
    <aside aria-labelledby="agency" className="lg:sticky lg:top-6 lg:self-start">
      <div className="rounded-lg border border-shore p-5">
        <h2 id="agency" className="text-sm font-semibold text-stone">
          {t('listing.agency')}
        </h2>
        {agency ? (
          <>
            <p className="mt-1 text-lg font-bold">
              <a href={agencyPath(props.locale, agency)} className="text-ink hover:text-sea">
                {agency.name}
              </a>
            </p>
            <AgencyContacts agency={agency} subject={props.subject} t={t} className="mt-4" />
            <p className="mt-4 text-xs text-stone">{t('listing.contactHint', { ref: props.reference })}</p>
            <p className="mt-3 text-sm">
              <a href={agencyPath(props.locale, agency)} className="text-sea hover:underline">
                {t('listing.agencyProfile', { agency: agency.name })}
              </a>
            </p>
            {props.children}
          </>
        ) : (
          <p className="mt-2 text-sm text-stone">{t('listing.unlisted')}</p>
        )}
      </div>
    </aside>
  );
}
