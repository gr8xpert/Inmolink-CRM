import { FALLBACK_CONTENT_LOCALE } from '@inmolink/i18n';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { requireStaff } from '@/server/staff';
import { fetchStaffTaxonomy, fetchStaffUnmatched } from '@/server/staff-taxonomy';
import { catalogGroups, parseQueueKind, QUEUE_KINDS, QUEUE_PAGE_SIZE } from './queue-logic';
import { UnmatchedQueue } from './unmatched-queue';

const TAB_LABEL = { propertyType: 'tabs.propertyTypes', location: 'tabs.locations', feature: 'tabs.features' } as const;

/**
 * Staff mapping queue (S17-F22): the feed values no taxonomy item answers, most-seen first. Every staff role can
 * look; super admins and data ops can map or ignore (the API enforces it and audits each change). One tab per kind,
 * in the URL, so each loads its own first page.
 */
export default async function StaffUnmatchedPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const { session, me } = await requireStaff();
  const kind = parseQueueKind((await searchParams).kind);
  const [tree, page] = await Promise.all([
    fetchStaffTaxonomy(session),
    fetchStaffUnmatched(session, { kind, limit: QUEUE_PAGE_SIZE }),
  ]);
  if (tree === 'revoked' || page === 'revoked') redirect('/session/expired');
  if ((!tree.ok && tree.status === 403) || (!page.ok && page.status === 403)) notFound();
  const t = await getTranslations('staff.taxonomy');
  const messages = (await getMessages()) as { staff: { taxonomy: Record<string, unknown> } };
  const locale = await getLocale();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t('unmatched.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('unmatched.intro')}</p>
        <p className="text-sm text-muted-foreground">{t('unmatched.holdRule')}</p>
        <Link href="/staff/taxonomy" className="self-start text-sm font-medium underline-offset-4 hover:underline">
          {t('unmatched.toEditor')}
        </Link>
      </div>
      <nav aria-label={t('unmatched.kinds')} className="flex gap-4 border-b text-sm">
        {QUEUE_KINDS.map((k) => (
          <Link
            key={k}
            href={`/staff/taxonomy/unmatched?kind=${k}`}
            aria-current={k === kind ? 'page' : undefined}
            className={`-mb-px border-b-2 pb-2 ${k === kind ? 'border-primary font-semibold' : 'border-transparent'}`}
          >
            {t(TAB_LABEL[k])}
          </Link>
        ))}
      </nav>
      {!tree.ok || !page.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      ) : (
        <UnmatchedQueue
          key={kind}
          kind={kind}
          initial={page.data}
          groups={kind === 'location' ? [] : catalogGroups(tree.data, kind)}
          locations={kind === 'location' ? tree.data.locations : []}
          canWrite={me.role !== 'STAFF_SUPPORT'}
          newItemLocale={FALLBACK_CONTENT_LOCALE}
          locale={locale}
          messages={messages.staff.taxonomy}
        />
      )}
    </div>
  );
}
