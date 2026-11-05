import { Button } from '@inmolink/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { enterClientModeAction, exitClientModeAction } from '@/app/[locale]/(app)/(signed-in)/client-mode/actions';
import { CLIENT_MODE_ERRORS } from '@/app/[locale]/(app)/(signed-in)/client-mode/state';
import { logoutAction } from '@/app/[locale]/(auth)/actions';
import { CookieSettingsButton } from '@/components/legal/cookie-settings-button';
import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { webConfig } from '@/server/env';
import type { Shell } from '@/server/shell';
import { ClientModeBanner, type ClientModeLabels, ClientModeStart } from './client-mode-control';
import { LocaleSwitcher } from './locale-switcher';
import { NotificationsBell } from './notifications-bell';
import { PrimaryNav } from './primary-nav';
import { SearchDialog } from './search-dialog';

/** A language's name in itself, capitalised ("Español"). */
function nativeName(code: string): string {
  const name = new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code;
  return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
}

/**
 * The authenticated dashboard frame (S1-10): top bar (brand, search, notifications,
 * language, account), the role-based navigation and the `main` landmark every page renders into.
 * A server component; the interactive parts are small client islands with their strings as props.
 */
export async function DashboardShell({ shell, children }: { shell: Shell; children: ReactNode }) {
  const t = await getTranslations('shell');
  const legal = await getTranslations('legal');
  const locale = await getLocale();
  const realtimeUrl = shell.unread ? (await webConfig()).REALTIME_PUBLIC_URL : null;
  const caps = shell.identity.kind === 'member' ? shell.identity.caps : null;
  const locales = routing.locales.map((code) => ({ code, name: nativeName(code) }));
  // S12-06: Client Mode — start it from the account panel, end it from the banner (with the PIN).
  const cm = await getTranslations('shell.clientModeControl');
  const clientModeLabels: ClientModeLabels = {
    start: cm('start'),
    intro: cm('intro'),
    pin: cm('pin'),
    confirm: cm('confirm'),
    submit: cm('submit'),
    cancel: cm('cancel'),
    banner: t('clientMode'),
    exitPin: cm('exitPin'),
    exit: cm('exit'),
    errors: Object.fromEntries(CLIENT_MODE_ERRORS.map((e) => [e, cm(`errors.${e}`)])) as ClientModeLabels['errors'],
  };
  const roleLabel =
    shell.identity.kind === 'member'
      ? (await getTranslations('team'))(`roles.${shell.identity.caps.role}`)
      : shell.identity.kind === 'staff'
        ? (await getTranslations('staff'))(`roles.${shell.identity.role}`)
        : null;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 items-center gap-3 border-b px-4">
        <Link href="/" className="font-semibold tracking-tight">
          {t('brand')}
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <SearchDialog
            labels={{
              open: t('search.open'),
              title: t('search.title'),
              input: t('search.input'),
              comingSoon: t('search.comingSoon'),
              close: t('search.close'),
            }}
          />
          {/* Notifications belong to an agency member: staff have no feed, and the page could only show an error. */}
          {caps ? (
            <NotificationsBell
              labels={{
                open: t('notifications.open'),
                title: t('notifications.title'),
                empty: t('notifications.empty'),
                emptyBody: t('notifications.emptyBody'),
                viewAll: t('notifications.viewAll'),
                unread: t('notifications.unread'),
              }}
              unread={shell.unread}
              realtimeUrl={realtimeUrl}
            />
          ) : null}
          <div className="hidden sm:block">
            <LocaleSwitcher label={t('locale.label')} current={locale} locales={locales} />
          </div>
        </div>
      </header>
      {caps?.clientMode ? <ClientModeBanner action={exitClientModeAction} labels={clientModeLabels} /> : null}
      <div className="flex flex-1 flex-col md:flex-row">
        <div className="flex flex-col md:w-60 md:shrink-0 md:border-r">
          <PrimaryNav
            label={t('nav.label')}
            openLabel={t('nav.open')}
            closeLabel={t('nav.close')}
            items={shell.nav.map((item) => ({ href: item.href, label: t(`nav.${item.key}`) }))}
            account={
              <section
                aria-label={t('account.label')}
                className="flex flex-col gap-2 border-b p-4 text-sm md:border-t md:border-b-0"
              >
                <p className="truncate font-medium">{shell.user.name || shell.user.email}</p>
                <p className="truncate text-muted-foreground">
                  {shell.user.email}
                  {roleLabel ? ` · ${roleLabel}` : ''}
                </p>
                <div className="sm:hidden">
                  <LocaleSwitcher label={t('locale.label')} current={locale} locales={locales} />
                </div>
                {caps?.impersonating ? (
                  <p className="text-xs text-muted-foreground" data-testid="client-mode-acting">
                    {t('actingUnavailable')}
                  </p>
                ) : caps && !caps.clientMode ? (
                  <ClientModeStart action={enterClientModeAction} labels={clientModeLabels} />
                ) : null}
                {/* S16-04 review: the legal pages and the cookie choice, from every dashboard page */}
                <nav
                  aria-label={legal('nav.label')}
                  className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"
                >
                  <Link href="/legal/privacy" className="underline">
                    {legal('nav.privacy')}
                  </Link>
                  <Link href="/legal/terms" className="underline">
                    {legal('nav.terms')}
                  </Link>
                  <CookieSettingsButton label={legal('consent.settings')} />
                </nav>
                {/* S12-06 review: no sign-out in Client Mode — the PIN ends it (and a new login resumes it anyway). */}
                {caps?.clientMode ? null : (
                  <form action={logoutAction}>
                    <Button type="submit" variant="outline" size="sm" className="w-full">
                      {t('account.logout')}
                    </Button>
                  </form>
                )}
              </section>
            }
          />
        </div>
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 focus:outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}
