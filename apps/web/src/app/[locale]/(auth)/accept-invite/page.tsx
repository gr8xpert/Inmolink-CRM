import { PASSWORD_MIN_LENGTH } from '@inmolink/contracts';
import { getTranslations } from 'next-intl/server';
import { formErrors } from '@/server/form-errors';
import { acceptInviteAction } from '../actions';
import { AuthForm } from '../auth-form';

/** Invite link from the email (S1-02): name + password create the account in the inviting agency. */
export default async function AcceptInvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const t = await getTranslations('auth');
  const { token } = await searchParams;
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">{t('invite.title')}</h1>
      {token ? (
        <AuthForm
          action={acceptInviteAction}
          hidden={{ token }}
          intro={t('invite.body')}
          submitLabel={t('invite.submit')}
          errors={await formErrors()}
          fields={[
            { name: 'name', label: t('invite.name'), type: 'text', autoComplete: 'name' },
            {
              name: 'password',
              label: t('invite.password'),
              type: 'password',
              autoComplete: 'new-password',
              hint: t('signup.passwordHint', { min: PASSWORD_MIN_LENGTH }),
            },
          ]}
        />
      ) : (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.tokenInvalid')}
        </p>
      )}
    </>
  );
}
