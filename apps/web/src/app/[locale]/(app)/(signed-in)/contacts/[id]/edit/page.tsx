import { CONTACT_TYPES } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchContact } from '@/server/contacts-api';
import { ContactEditForm } from './contact-edit-form';
import { editValuesOf } from './parse';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_CODES = [
  'CONTACT_NOT_FOUND',
  'CONTACT_PHONE_INVALID',
  'VERSION_CONFLICT',
  'VALIDATION_FAILED',
  'FORBIDDEN',
  'generic',
] as const;

/** Edit a contact (S17-F28), at the version loaded here: the API refuses a save over someone else's change. */
export default async function EditContactPage({ params }: { params: Promise<{ id: string }> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const { id } = await params;
  if (!UUID.test(id)) return localeRedirect({ href: '/contacts', locale });
  const t = await getTranslations('contacts');
  const contact = await fetchContact(sessionRef(session.user), id);
  if (contact === 'revoked') redirect('/session/expired');
  if (!contact.ok) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
        <Link href="/contacts" className="text-sm underline-offset-4 hover:underline">
          {t('detail.back')}
        </Link>
        <p role="alert" className="text-sm text-destructive">
          {contact.status === 404 ? t('errors.CONTACT_NOT_FOUND') : t('errors.generic')}
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">{t('edit.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('edit.intro')}</p>
      <ContactEditForm
        id={contact.data.id}
        version={contact.data.version}
        initial={editValuesOf(contact.data)}
        labels={{
          firstName: t('fields.firstName'),
          lastName: t('fields.lastName'),
          emails: t('fields.emails'),
          emailsHint: t('edit.emailsHint'),
          phones: t('fields.phones'),
          phonesHint: t('edit.phonesHint'),
          language: t('fields.language'),
          languageHint: t('edit.languageHint'),
          tags: t('fields.tags'),
          tagsHint: t('edit.tagsHint'),
          types: t('fields.types'),
          consentMarketing: t('fields.consentMarketing'),
          consentProcessing: t('fields.consentProcessing'),
          consentHint: t('edit.consentHint'),
          doNotContact: t('fields.doNotContact'),
          doNotContactHint: t('edit.doNotContactHint'),
          submit: t('edit.submit'),
          cancel: t('edit.cancel'),
          duplicate: t('edit.duplicate'),
          open: t('edit.open'),
        }}
        typeLabels={CONTACT_TYPES.map((value) => ({ value, label: t(`types.${value}`) }))}
        errors={Object.fromEntries(ERROR_CODES.map((c) => [c, t(`errors.${c}`)]))}
      />
    </div>
  );
}
