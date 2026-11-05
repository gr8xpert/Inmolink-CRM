import type { RegistrationTargetKind } from '@inmolink/contracts';
import { buttonVariants } from '@inmolink/ui';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';

/** "Register client" for another agency's listing or development (S17-F56); the page behind it holds the form. */
export async function RegisterClientLink({ kind, id }: { kind: RegistrationTargetKind; id: string }) {
  const t = await getTranslations('network.collaborations.register');
  return (
    <Link
      href={`/collaborations/register?${new URLSearchParams({ kind, id }).toString()}`}
      className={buttonVariants({ variant: 'outline', size: 'sm' })}
    >
      {t('cta')}
    </Link>
  );
}
