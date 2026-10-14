import { CONTENT_LOCALES, DEFAULT_CONTENT_LOCALE } from '@inmolink/i18n';
import { notFound, redirect } from 'next/navigation';
import { getMessages, getTranslations } from 'next-intl/server';
import { webConfig } from '@/server/env';
import { requireStaff } from '@/server/staff';
import { fetchStaffTaxonomy } from '@/server/staff-taxonomy';
import { TaxonomyEditor } from './taxonomy-editor';

/**
 * Staff taxonomy editor (S2-04, PLAN §7 M4): location tree, property types and features. Every staff role can
 * look; super admins and data ops can change (the API enforces it and audits each change). The tree is read
 * uncached so an edit shows at once.
 */
export default async function StaffTaxonomyPage() {
  const { session, me } = await requireStaff();
  const res = await fetchStaffTaxonomy(session);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok && res.status === 403) notFound();
  const t = await getTranslations('staff.taxonomy');
  const messages = (await getMessages()) as { staff: { taxonomy: Record<string, unknown> } };
  const config = await webConfig();

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </div>
      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      ) : (
        <TaxonomyEditor
          tree={res.data}
          canWrite={me.role !== 'STAFF_SUPPORT'}
          locales={CONTENT_LOCALES}
          defaultLocale={DEFAULT_CONTENT_LOCALE}
          mapStyleUrl={config.MAP_STYLE_URL}
          messages={messages.staff.taxonomy}
        />
      )}
    </div>
  );
}
