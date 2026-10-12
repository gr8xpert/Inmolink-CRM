import { DirectorySearchQuery, PREFERRED_AGENCY_NOTE_MAX } from '@inmolink/contracts';
import { Button, EmptyState, Input, Label } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchPreferredAgencies, searchAgencyDirectory, sessionRef } from '@/server/api';
import { addPreferredAction, removePreferredAction, saveNoteAction } from './actions';

const DONE = ['added', 'removed', 'noted'] as const;
/** Codes with their own message under `agency.preferred.errors`; the rest use `agency.errors`. */
const PREFERRED_ERRORS = [
  'PREFERRED_AGENCY_INVALID',
  'PREFERRED_AGENCY_EXISTS',
  'PREFERRED_AGENCY_LIMIT_REACHED',
  'VERIFICATION_REQUIRED',
  'NOT_FOUND',
] as const;
const GENERAL_ERRORS: Record<string, 'forbidden' | 'invalidInput' | 'generic'> = {
  FORBIDDEN: 'forbidden',
  VALIDATION_FAILED: 'invalidInput',
  generic: 'generic',
};

/**
 * Preferred agencies (S1-07): the agency's trusted partners with internal notes, and a directory search
 * of verified agencies to add one. Every member sees the list; the API lets only admins change it.
 */
export default async function PreferredAgenciesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const params = await searchParams;
  const ref = sessionRef(session.user);
  const query = DirectorySearchQuery.safeParse({ q: params.q ?? '' });
  const [list, found] = await Promise.all([
    fetchPreferredAgencies(ref, params.cursor || undefined),
    query.success ? searchAgencyDirectory(ref, query.data.q) : Promise.resolve(null),
  ]);
  if (list === 'revoked' || found === 'revoked') redirect('/session/expired');
  const t = await getTranslations('agency');
  const format = await getFormatter();
  const done = DONE.find((d) => d === params.done);
  const preferredError = PREFERRED_ERRORS.find((e) => e === params.error);
  const generalError = params.error ? GENERAL_ERRORS[params.error] : undefined;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('preferred.title')}</h1>
        <Link href="/" className="text-sm underline-offset-4 hover:underline">
          {t('back')}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{t('preferred.intro')}</p>
      {done ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {t(`preferred.done.${done}`)}
        </p>
      ) : null}
      {preferredError || generalError ? (
        <p role="alert" className="text-sm text-destructive">
          {preferredError ? t(`preferred.errors.${preferredError}`) : t(`errors.${generalError ?? 'generic'}`)}
        </p>
      ) : null}

      <section aria-labelledby="preferred-heading" className="flex flex-col gap-2">
        <h2 id="preferred-heading" className="sr-only">
          {t('preferred.title')}
        </h2>
        {!list.ok ? (
          <p role="alert" className="text-sm text-destructive">
            {list.status === 403 ? t('errors.forbidden') : t('errors.generic')}
          </p>
        ) : list.data.items.length === 0 ? (
          <EmptyState title={t('preferred.empty')} />
        ) : (
          <ul className="divide-y rounded-md border" data-testid="preferred-agencies">
            {list.data.items.map((p) => (
              <li key={p.agencyId} className="flex flex-col gap-2 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{p.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {p.listed ? t('preferred.listed') : t('preferred.unlisted')} ·{' '}
                      {t('preferred.added', { date: format.dateTime(new Date(p.addedAt), { dateStyle: 'medium' }) })}
                    </p>
                  </div>
                  <form action={removePreferredAction}>
                    <input type="hidden" name="agencyId" value={p.agencyId} />
                    <Button type="submit" variant="outline" size="sm">
                      {t('preferred.remove')}
                    </Button>
                  </form>
                </div>
                <form action={saveNoteAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="agencyId" value={p.agencyId} />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <Label htmlFor={`note-${p.agencyId}`}>{t('preferred.note')}</Label>
                    <Input
                      id={`note-${p.agencyId}`}
                      name="note"
                      defaultValue={p.note ?? ''}
                      maxLength={PREFERRED_AGENCY_NOTE_MAX}
                    />
                  </div>
                  <Button type="submit" variant="outline" size="sm">
                    {t('preferred.saveNote')}
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
        {list.ok && list.data.nextCursor ? (
          <Link
            href={{ pathname: '/preferred-agencies', query: { cursor: list.data.nextCursor } }}
            className="text-sm underline-offset-4 hover:underline"
          >
            {t('preferred.more')}
          </Link>
        ) : null}
      </section>

      <section aria-labelledby="search-heading" className="flex flex-col gap-3">
        <h2 id="search-heading" className="font-medium">
          {t('preferred.search.title')}
        </h2>
        <form method="get" className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Label htmlFor="directory-q">{t('preferred.search.label')}</Label>
            <Input
              id="directory-q"
              name="q"
              defaultValue={params.q ?? ''}
              minLength={3}
              maxLength={80}
              placeholder={t('preferred.search.placeholder')}
            />
          </div>
          <Button type="submit" variant="outline" size="sm">
            {t('preferred.search.submit')}
          </Button>
        </form>
        {found && !found.ok ? (
          <p role="alert" className="text-sm text-destructive">
            {found.status === 403 ? t('preferred.search.verifiedOnly') : t('errors.generic')}
          </p>
        ) : null}
        {found?.ok && query.success ? (
          found.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('preferred.search.none', { q: query.data.q })}</p>
          ) : (
            <ul className="divide-y rounded-md border" data-testid="directory-results">
              {found.data.items.map((a) => (
                <li key={a.agencyId} className="flex flex-wrap items-center justify-between gap-2 p-3">
                  <p className="min-w-0 truncate text-sm font-medium">{a.name}</p>
                  {a.preferred ? (
                    <span className="text-xs text-muted-foreground">{t('preferred.search.alreadyAdded')}</span>
                  ) : (
                    <form action={addPreferredAction}>
                      <input type="hidden" name="agencyId" value={a.agencyId} />
                      <Button type="submit" size="sm">
                        {t('preferred.search.add')}
                      </Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>
    </div>
  );
}
