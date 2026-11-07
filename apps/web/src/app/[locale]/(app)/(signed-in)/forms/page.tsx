import { FORM_TEMPLATES } from '@inmolink/contracts';
import { Button, buttonVariants } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { ClientModeUnavailable } from '@/components/shell/client-mode-unavailable';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchForms } from '@/server/forms-api';
import { inClientMode } from '@/server/nav';
import { loadShell } from '@/server/shell';
import { FormList, PlaceholderNotice, type T } from './parts';
import { cursorOf, errorKey, errorOf, templateOf, uuidOf } from './query';

const FIELD = 'h-9 rounded-md border bg-background px-2';

/**
 * The agency's forms (R2-05c, PLAN §7 M13): newest first, by template and by one contact, listing or deal (the entry
 * points link here with theirs); each into its page. Behind `documents.forms`: off, the API answers FORMS_NOT_ENABLED
 * and the screen says the forms library is not available.
 */
export default async function FormsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const shell = await loadShell();
  if (shell && inClientMode(shell.identity)) return <ClientModeUnavailable />;
  const q = await searchParams;
  const template = templateOf(q.template);
  const contactId = uuidOf(q.contactId);
  const listingId = contactId ? undefined : uuidOf(q.listingId);
  const dealId = contactId || listingId ? undefined : uuidOf(q.dealId);
  const cursor = cursorOf(q.cursor);
  const res = await fetchForms(sessionRef(session.user), { template, contactId, listingId, dealId, cursor });
  if (res === 'revoked') redirect('/session/expired');
  const tt = await getTranslations('documents.dashboard');
  const t: T = (key, values) => tt(key as never, values as never);
  const format = await getFormatter();
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const scope = contactId ? { contactId } : listingId ? { listingId } : dealId ? { dealId } : {};
  const scopeKind = contactId ? 'contact' : listingId ? 'listing' : dealId ? 'deal' : null;
  const error = errorOf(q.error);

  const header = (
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <Link
        href={{
          pathname: '/forms/new',
          query: { ...(contactId ? { contactId } : {}), ...(listingId ? { listingId } : {}) },
        }}
        className={buttonVariants({ size: 'sm' })}
      >
        {t('new')}
      </Link>
    </header>
  );

  if (!res.ok && res.error?.code === 'FORMS_NOT_ENABLED') {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {t('errors.FORMS_NOT_ENABLED')}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6">
      {header}
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <PlaceholderNotice t={t} />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorKey(error, null)}`)}
        </p>
      ) : null}
      <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
        {Object.entries(scope).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <label className="flex flex-col gap-1">
          <span>{t('filters.template')}</span>
          <select name="template" defaultValue={template ?? ''} className={FIELD}>
            <option value="">{t('filters.all')}</option>
            {FORM_TEMPLATES.map((k) => (
              <option key={k} value={k}>
                {t(`templates.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="outline" size="sm">
          {t('filters.apply')}
        </Button>
        {scopeKind || template ? (
          <Link href="/forms" className="underline-offset-4 hover:underline">
            {t('filters.clear')}
          </Link>
        ) : null}
      </form>
      {scopeKind ? <p className="text-sm text-muted-foreground">{t(`filters.scoped.${scopeKind}`)}</p> : null}
      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorKey(errorOf(res.error?.code) ?? 'generic', null)}`)}
        </p>
      ) : (
        <>
          <FormList items={res.data.items} t={t} date={date} />
          {res.data.nextCursor ? (
            <Link
              href={{
                pathname: '/forms',
                query: { ...scope, ...(template ? { template } : {}), cursor: res.data.nextCursor },
              }}
              className="self-start text-sm font-medium underline-offset-4 hover:underline"
            >
              {t('more')}
            </Link>
          ) : null}
        </>
      )}
    </div>
  );
}
