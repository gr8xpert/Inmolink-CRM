import type { Crumb, PortalMember } from '@inmolink/core/modules/website-api';
import { getTranslations } from 'next-intl/server';
import { agencyPath, mailtoHref } from '../urls';
import { AgencyLogo } from './agency-logo';
import { MemberPhoto } from './agency-profile';
import { Breadcrumbs } from './breadcrumbs';
import { languageName } from './shell';

/**
 * A member's portal page (S15-F10): the name, photo and languages they published, the phone / e-mail they chose to
 * publish (as call / mail actions; a plain address only), and their agency — its logo, name and profile link. Nothing
 * else of the member: no role, login e-mail or anything the agency holds about them.
 */
export async function MemberProfile(props: { locale: string; member: PortalMember; crumbs: readonly Crumb[] }) {
  const { member, locale } = props;
  const t = await getTranslations({ locale, namespace: 'portal' });
  const mailto = mailtoHref(member.email, t('member.mailSubject'));
  const agencyHref = agencyPath(locale, member.agency);
  return (
    <div className="mx-auto max-w-6xl px-4 pt-6 pb-16">
      <Breadcrumbs label={t('breadcrumb.label')} crumbs={props.crumbs} />
      <div className="mt-6 grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <header className="flex flex-col gap-6 sm:flex-row sm:items-center">
          <MemberPhoto name={member.name} photoUrl={member.photoUrl} size="lg" />
          <div className="min-w-0">
            <h1 className="text-[clamp(2rem,5vw,3rem)] font-extrabold leading-tight tracking-tight text-ink">
              {member.name}
            </h1>
            <p className="mt-2 flex items-center gap-3 text-base text-stone">
              <AgencyLogo agency={member.agency} size="md" />
              <span>
                {t('member.worksAt')}{' '}
                <a href={agencyHref} className="font-medium text-sea hover:underline">
                  {member.agency.name}
                </a>
              </span>
            </p>
            {member.languages.length > 0 ? (
              <dl className="mt-5 text-sm">
                <dt className="text-stone">{t('member.languages')}</dt>
                <dd className="mt-0.5 font-medium text-ink">
                  {member.languages.map((l) => languageName(locale, l)).join(', ')}
                </dd>
              </dl>
            ) : null}
          </div>
        </header>
        <aside aria-labelledby="contact" className="lg:self-start">
          <div className="rounded-lg border border-shore p-5">
            <h2 id="contact" className="text-sm font-semibold text-stone">
              {t('member.contact', { name: member.name })}
            </h2>
            <ul className="mt-3 grid gap-2 text-sm">
              {member.phone ? (
                <li>
                  <a
                    href={`tel:${member.phone.replace(/[^\d+]/g, '')}`}
                    className="block rounded-md bg-sea px-4 py-2 text-center font-semibold text-white hover:bg-sea-deep"
                  >
                    {t('member.call')} {member.phone}
                  </a>
                </li>
              ) : null}
              {mailto ? (
                <li>
                  <a
                    href={mailto}
                    className="block rounded-md border border-sea px-4 py-2 text-center font-semibold text-sea hover:bg-shore"
                  >
                    {t('member.email')}
                  </a>
                </li>
              ) : null}
              <li>
                <a href={agencyHref} className="text-sea hover:underline">
                  {t('member.agencyListings', { agency: member.agency.name })}
                </a>
              </li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
