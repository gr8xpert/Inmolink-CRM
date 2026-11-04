import { CONTACT_TYPES, SHEET_MAX_ROWS, SHEET_UPLOAD_MAX_BYTES } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getMessages, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchContactImports } from '@/server/contacts-api';
import { canImportContacts } from '@/server/nav';
import { loadShell } from '@/server/shell';
import { ImportEntry } from './import-entry';

/**
 * Import contacts from a CSV or Excel file (S17-F29) and the agency's recent imports. Admins only for the import itself:
 * everyone else sees a sentence instead of the form (S17-F30), and the API refuses them at the upload anyway.
 */
export default async function ImportContactsPage() {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const t = await getTranslations('contacts');
  const format = await getFormatter();
  const messages = (await getMessages()) as unknown as { contacts: Record<string, unknown> };
  const recent = await fetchContactImports(sessionRef(session.user));
  if (recent === 'revoked') redirect('/session/expired');
  const shell = await loadShell();
  const allowed = shell !== null && canImportContacts(shell.identity);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('import.title')}</h1>
        <Link href="/contacts" className="text-sm underline-offset-4 hover:underline">
          {t('import.back')}
        </Link>
      </div>
      {allowed ? (
        <>
          <div className="flex flex-col gap-1 text-sm text-muted-foreground">
            <p>{t('import.intro')}</p>
            <p>
              {t('import.fileHint', {
                mb: String(SHEET_UPLOAD_MAX_BYTES / (1024 * 1024)),
                rows: format.number(SHEET_MAX_ROWS),
              })}
            </p>
          </div>
          <ImportEntry messages={messages.contacts} contactTypes={CONTACT_TYPES} />
        </>
      ) : (
        <p className="rounded-md bg-muted p-3 text-sm" data-testid="contact-import-admins-only">
          {t('import.adminsOnly')}
        </p>
      )}

      <section className="flex flex-col gap-2 text-sm">
        <h2 className="text-base font-semibold">{t('import.recent')}</h2>
        {!recent.ok ? (
          <p role="alert" className="text-destructive">
            {t('errors.generic')}
          </p>
        ) : recent.data.items.length === 0 ? (
          <p className="text-muted-foreground">{t('import.noRecent')}</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-left" data-testid="contact-import-recent">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="p-2 font-medium">{t('import.recentColumns.date')}</th>
                  <th className="p-2 font-medium">{t('import.recentColumns.status')}</th>
                  <th className="p-2 font-medium">{t('import.recentColumns.result')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {recent.data.items.map((run) => (
                  <tr key={run.id}>
                    <td className="p-2">
                      {format.dateTime(new Date(run.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
                    </td>
                    <td className="p-2">{t(`import.status.${run.status}`)}</td>
                    <td className="p-2">
                      {t('import.counts', {
                        created: run.createdCount,
                        merged: run.mergedCount,
                        skipped: run.skippedCount,
                        invalid: run.invalidCount,
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
