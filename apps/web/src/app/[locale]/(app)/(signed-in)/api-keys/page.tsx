import { API_KEY_SCOPES } from '@inmolink/contracts';
import { Button, EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname, Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchApiKeys, sessionRef } from '@/server/api';
import { createKeyAction, revokeKeyAction, rotateKeyAction } from './actions';
import { KEY_ERRORS, type KeyError } from './errors';
import { CreateKeyForm, RotateKeyForm } from './key-forms';

/**
 * Website API keys (S1-05): agency admins list, create, rotate and revoke the keys their websites and
 * widgets use. A new or rotated key is shown once. Other roles get the API's refusal as a notice.
 */
export default async function ApiKeysPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const res = await fetchApiKeys(sessionRef(session.user));
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('api-keys');
  const format = await getFormatter();
  const params = await searchParams;
  const notice = params.notice === 'revoked' ? 'revoked' : undefined;
  const error = KEY_ERRORS.find((e) => e === params.error);

  const errors = Object.fromEntries(KEY_ERRORS.map((e) => [e, t(`errors.${e}`)])) as Record<KeyError, string>;
  const issued = {
    title: t('issued.title'),
    intro: t('issued.intro'),
    done: t('issued.done'),
    doneHref: getPathname({ href: '/api-keys', locale }),
  };
  /** Message key of a scope (`listings:read` → `listings_read`). */
  const scopeName = (s: string) => t(`scopes.${s.replace(/[:-]/g, '_')}` as never);
  const date = (iso: string | null) => (iso ? format.dateTime(new Date(iso), { dateStyle: 'medium' }) : t('never'));

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <Link href="/" className="text-sm underline-offset-4 hover:underline">
          {t('back')}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {notice ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {t(`notices.${notice}`)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {errors[error]}
        </p>
      ) : null}

      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive" data-testid="api-keys-refused">
          {res.error?.code === 'FORBIDDEN' ? errors.FORBIDDEN : errors.generic}
        </p>
      ) : (
        <>
          <section aria-labelledby="keys-heading" className="flex flex-col gap-2">
            <h2 id="keys-heading" className="font-medium">
              {t('list.title')}
            </h2>
            {res.data.items.length === 0 ? (
              <EmptyState title={t('list.empty')} />
            ) : (
              <ul className="divide-y rounded-md border" data-testid="api-keys">
                {res.data.items.map((k) => (
                  <li key={k.id} className="flex flex-wrap items-start justify-between gap-3 p-3 text-sm">
                    <div className="flex min-w-0 flex-col gap-1">
                      <p className="font-medium">
                        {k.name}{' '}
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{t(`kinds.${k.kind}`)}</span>
                        {k.status === 'REVOKED' ? (
                          <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-xs">
                            {t('list.revokedBadge')}
                          </span>
                        ) : null}
                      </p>
                      <p className="font-mono text-xs">{k.prefix}…</p>
                      <p className="text-xs text-muted-foreground">{k.scopes.map(scopeName).join(' · ')}</p>
                      {k.allowedOrigins.length > 0 ? (
                        <p className="break-all text-xs text-muted-foreground">{k.allowedOrigins.join(', ')}</p>
                      ) : null}
                      <p className="text-xs text-muted-foreground">
                        {t('list.meta', {
                          tier: t(`rateTiers.${k.rateTier}`),
                          created: date(k.createdAt),
                          lastUsed: date(k.lastUsedAt),
                        })}
                      </p>
                    </div>
                    {k.status === 'ACTIVE' ? (
                      <div className="flex flex-col items-end gap-2">
                        <RotateKeyForm
                          action={rotateKeyAction}
                          keyId={k.id}
                          label={t('list.rotate')}
                          issued={issued}
                          errors={errors}
                        />
                        <form action={revokeKeyAction}>
                          <input type="hidden" name="keyId" value={k.id} />
                          <Button type="submit" variant="outline" size="sm">
                            {t('list.revoke')}
                          </Button>
                        </form>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="create-heading" className="flex flex-col gap-3">
            <h2 id="create-heading" className="font-medium">
              {t('create.title')}
            </h2>
            <CreateKeyForm
              action={createKeyAction}
              scopes={API_KEY_SCOPES}
              errors={errors}
              issued={issued}
              labels={{
                name: t('create.name'),
                kind: t('create.kind'),
                kinds: { SECRET: t('kinds.SECRET'), PUBLISHABLE: t('kinds.PUBLISHABLE') },
                scopes: t('create.scopes'),
                scopeNames: Object.fromEntries(API_KEY_SCOPES.map((s) => [s, scopeName(s)])),
                origins: t('create.origins'),
                originsHint: t('create.originsHint'),
                submit: t('create.submit'),
              }}
            />
          </section>
        </>
      )}
    </div>
  );
}
