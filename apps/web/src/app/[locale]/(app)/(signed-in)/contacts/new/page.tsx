import { randomUUID } from 'node:crypto';
import { CONTACT_TYPES } from '@inmolink/contracts';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { ContactCreateForm } from './contact-create-form';

const ERROR_CODES = [
  'CONTACT_DUPLICATE',
  'CONTACT_PHONE_INVALID',
  'CONTACT_MERGE_INVALID',
  'VALIDATION_FAILED',
  'FORBIDDEN',
  'generic',
] as const;

/** Add a contact by hand. The contact types shown are the ones the list filters by. */
export default async function NewContactPage() {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const t = await getTranslations('contacts');

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">{t('create.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('create.intro')}</p>
      <ContactCreateFormWithLabels t={t} />
      <Link href="/contacts" className="text-sm underline-offset-4 hover:underline">
        {t('detail.back')}
      </Link>
    </div>
  );
}

function ContactCreateFormWithLabels({ t }: { t: Awaited<ReturnType<typeof getTranslations<'contacts'>>> }) {
  const one = t('duplicate.body', { count: 1 });
  const many = t('duplicate.body', { count: 2 });
  return (
    <ContactCreateForm
      idempotencyKey={randomUUID()}
      labels={{
        firstName: t('fields.firstName'),
        lastName: t('fields.lastName'),
        email: t('create.email'),
        phone: t('create.phone'),
        phoneHint: t('create.phoneHint'),
        types: t('fields.types'),
        consentMarketing: t('fields.consentMarketing'),
        consentProcessing: t('fields.consentProcessing'),
        submit: t('create.submit'),
        duplicateTitle: t('duplicate.title'),
        duplicateBody: one,
        duplicateBodyMany: many,
        duplicateMerge: t('duplicate.merge'),
        duplicateOpen: t('create.open'),
      }}
      typeLabels={CONTACT_TYPES.map((value) => ({ value, label: t(`types.${value}`) }))}
      errors={Object.fromEntries(ERROR_CODES.map((c) => [c, t(`errors.${c}`)]))}
    />
  );
}
