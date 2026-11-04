import { CONTENT_LOCALES, DEFAULT_CONTENT_LOCALE } from '@inmolink/i18n';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { ClientModeUnavailable } from '@/components/shell/client-mode-unavailable';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { inClientMode, isAgencyAdmin } from '@/server/nav';
import { loadShell } from '@/server/shell';
import { MapperEntry } from './mapper-entry';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The visual XML mapper (S6-04). Admins only: everyone else sees a sentence (S17-F34), and the API refuses them anyway. */
export default async function MapperPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const locale = await getLocale();
  const connection = (await searchParams).connection;
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const shell = await loadShell();
  if (shell && inClientMode(shell.identity)) return <ClientModeUnavailable />;
  const admin = shell !== null && isAgencyAdmin(shell.identity);
  if (!admin) {
    const denied = await getTranslations('imports.mapper');
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
        <h1 className="text-xl font-semibold">{denied('title')}</h1>
        <p className="rounded-md bg-muted p-3 text-sm" data-testid="admin-only">
          {denied('adminOnly')}
        </p>
      </div>
    );
  }
  const t = await getTranslations('imports.mapper');
  const messages = (await getMessages()) as unknown as { imports: { mapper: Record<string, unknown> } };
  const locales = [DEFAULT_CONTENT_LOCALE, ...CONTENT_LOCALES.filter((l) => l !== DEFAULT_CONTENT_LOCALE)];
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <Link href="/imports" className="text-sm underline-offset-4 hover:underline">
          {t('back')}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <MapperEntry
        messages={messages.imports.mapper}
        locales={locales}
        defaultLocale={DEFAULT_CONTENT_LOCALE}
        connectionId={connection && UUID.test(connection) ? connection : undefined}
      />
    </div>
  );
}
