import { portalCrumbs, portalJsonLd, portalMetadataFor, serializeJsonLd } from '@inmolink/core/modules/website-api';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { assertPortalLocale, memberOf, portalSettings } from '@/portal/data';
import { legacyRedirectFor } from '@/portal/legacy';
import { JsonLd } from '@/portal/ui/breadcrumbs';
import { MemberProfile } from '@/portal/ui/member-profile';
import { PortalShell } from '@/portal/ui/shell';

/**
 * A member's profile page (S15-F10, PLAN §7 M14): `/agent/<profile id>/<name>` — what a member of a directory-listed
 * agency chose to publish (name, photo, languages, phone / e-mail), linked from the agency's profile. Anything else —
 * an unpublished profile, a deactivated member, an agency not listed, a legacy numeric id — has no page: the legacy
 * redirects answer first (an old `/agent/<id>` keeps its 301 to the agency's profile), then a 404. An old name slug
 * (or any query string) moves to the one URL. Rendered per request; the profile is cached a minute (0–2 statements).
 */

type Props = {
  params: Promise<{ locale: string; id: string; name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, id } = await params;
  assertPortalLocale(locale);
  const member = await memberOf(id);
  if (!member) return {};
  return portalMetadataFor({ kind: 'member', locale, origin: (await portalSettings()).origin, member });
}

export default async function MemberPage({ params, searchParams }: Props) {
  const { locale, id, name } = await params;
  assertPortalLocale(locale);
  setRequestLocale(locale);
  const member = await memberOf(id);
  if (!member) {
    const to = await legacyRedirectFor(`/${locale}/agent/${id}/${name}`);
    if (to) permanentRedirect(to);
    notFound();
  }
  const path = member.paths[locale] as string;
  // One URL per member and locale: an old name, another spelling of the id or a query string moves to it.
  if (path !== `/${locale}/agent/${id}/${name}` || Object.keys(await searchParams).length > 0) permanentRedirect(path);
  const page = { kind: 'member', locale, origin: (await portalSettings()).origin, member } as const;
  return (
    <PortalShell locale={locale} alternates={member.paths}>
      {portalJsonLd(page).map((ld) => (
        <JsonLd key={(ld as { '@type': string })['@type']} json={serializeJsonLd(ld)} />
      ))}
      <MemberProfile locale={locale} member={member} crumbs={portalCrumbs(page)} />
    </PortalShell>
  );
}
