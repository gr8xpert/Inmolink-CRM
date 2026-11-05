import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import type { CollaborationBlock } from './rights';

/** Why the member sees no collaboration controls (S17-F56): one sentence, and the way out when there is one. */
export async function BlockNotice({ block }: { block: CollaborationBlock }) {
  const t = await getTranslations('network.collaborations.blocked');
  return (
    <p role="status" className="rounded-md bg-muted p-3 text-sm" data-testid="collaboration-block">
      {t(block)}{' '}
      {block === 'UNVERIFIED' ? (
        <Link href="/verification" className="font-medium underline underline-offset-4">
          {t('verifyLink')}
        </Link>
      ) : null}
      {block === 'LOCKED' ? (
        <Link href="/listings" className="font-medium underline underline-offset-4">
          {t('shareLink')}
        </Link>
      ) : null}
    </p>
  );
}
