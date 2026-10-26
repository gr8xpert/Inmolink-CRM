import type { PortalAgencyProfile } from '@inmolink/core/modules/website-api';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { getTranslations } from 'next-intl/server';
import type { PortalSettings } from '../data';
import { AgencyContacts } from './agency-contacts';
import { EnquiryForm } from './enquiry-form';
import { languageName } from './shell';

/** Up to two initials of the agency's name: its mark until agencies can publish a logo. */
export function initialsOf(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
  return words
    .slice(0, 2)
    .map((w) => w.charAt(0).toLocaleUpperCase())
    .join('');
}

/** About text as paragraphs (blank lines), rendered as text — never as markup. */
const paragraphsOf = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

/**
 * The agency's own words as one plain text (meta description): its tagline and about text, a sentence stop between
 * them only where the tagline has none ("Homes by the sea. We sell…", never "sea.. We"). Null without either. Core's
 * `portalProfileSummary` (S15-F7: the meta description is built there).
 */
export const profileSummary = websiteApi.portalProfileSummary;

/** "Estate agency in Puerto" / "Property developer" (core's `portalAgencySubline`). */
export async function agencySubline(locale: string, agency: PortalAgencyProfile): Promise<string> {
  return websiteApi.portalAgencySubline(locale, agency);
}

/**
 * An agency profile's opening (S15-03): its mark, kind and town, the verified-business note (only directory-listed
 * agencies have a page), its tagline and about text (in the language it wrote them: `lang`), the facts it states
 * (register number, languages) beside its published contact details and the contact form. Everything shown is what
 * the agency published (profile, company details staff verified) — no tax id, address, members or commission.
 */
export async function AgencyProfileIntro(props: {
  locale: string;
  agency: PortalAgencyProfile;
  /** The profile page's path (the form's no-JavaScript answer comes back here). */
  path: string;
  settings: PortalSettings;
  /** Page 1 shows the whole profile; numbered pages only the line under the name. */
  full: boolean;
}) {
  const { agency } = props;
  const t = await getTranslations({ locale: props.locale, namespace: 'portal' });
  const subline = await agencySubline(props.locale, agency);
  const textLang = agency.textLocale && agency.textLocale !== props.locale ? agency.textLocale : undefined;
  if (!props.full) {
    return <p className="mt-3 text-base text-stone">{subline}</p>;
  }
  const about = agency.description ? paragraphsOf(agency.description) : [];
  return (
    <div className="mt-5 grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0">
        <div className="flex items-center gap-4">
          <span
            aria-hidden="true"
            className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-sea-deep text-xl font-extrabold tracking-tight text-white"
          >
            {initialsOf(agency.name)}
          </span>
          <div>
            <p className="text-base font-medium text-ink">{subline}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-sm text-pine">
              <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 fill-current">
                <path d="M8 0.8 2 3.3v4.3c0 3.6 2.5 6.8 6 7.6 3.5-.8 6-4 6-7.6V3.3L8 .8Zm-1 10.4L4.2 8.4l1.1-1.1L7 9l3.7-3.7 1.1 1.1L7 11.2Z" />
              </svg>
              {t('agency.verified')}
            </p>
          </div>
        </div>
        {agency.tagline ? (
          <p lang={textLang} className="mt-6 max-w-[40ch] text-xl font-semibold leading-snug text-sea-deep">
            {agency.tagline}
          </p>
        ) : null}
        {about.length > 0 ? (
          <section aria-labelledby="about" className="mt-6">
            <h2 id="about" className="text-sm font-semibold text-stone">
              {t('agency.about', { agency: agency.name })}
            </h2>
            <div lang={textLang} className="mt-2 grid max-w-[68ch] gap-3 text-base leading-relaxed text-ink">
              {about.map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs of one fixed text, never reordered.
                <p key={i}>{p}</p>
              ))}
            </div>
          </section>
        ) : null}
        {agency.registerNumber || agency.languages.length > 0 ? (
          <dl className="mt-6 grid max-w-xl gap-x-8 gap-y-3 border-t border-shore pt-5 text-sm sm:grid-cols-2">
            {agency.registerNumber ? (
              <div>
                <dt className="text-stone">{t('agency.register')}</dt>
                <dd className="mt-0.5 font-medium tabular-nums text-ink">{agency.registerNumber}</dd>
              </div>
            ) : null}
            {agency.languages.length > 0 ? (
              <div>
                <dt className="text-stone">{t('agency.languages')}</dt>
                <dd className="mt-0.5 font-medium text-ink">
                  {agency.languages.map((l) => languageName(props.locale, l)).join(', ')}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </div>
      <aside aria-labelledby="contact" className="lg:self-start">
        <div className="rounded-lg border border-shore p-5">
          <h2 id="contact" className="text-sm font-semibold text-stone">
            {t('agency.contact')}
          </h2>
          <AgencyContacts agency={agency} subject={t('agency.mailSubject')} t={t} className="mt-3" />
          <EnquiryForm
            locale={props.locale}
            about={{ agencyId: agency.id }}
            back={props.path}
            agency={agency.name}
            messageDefault={t('enquiry.messageDefaultAgency')}
            turnstileSiteKey={props.settings.turnstileSiteKey}
            turnstileAction={websiteApi.LEAD_TURNSTILE_ACTION}
            t={t as (key: string, values?: Record<string, string>) => string}
          />
        </div>
      </aside>
    </div>
  );
}
