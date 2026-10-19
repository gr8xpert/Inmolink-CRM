import type { FeedConnectionDto } from '@inmolink/contracts';
import { Button, Input, Label } from '@inmolink/ui';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { createConnectionAction, updateConnectionAction } from './actions';

/**
 * The create / edit form of a Kyero connection (S6-03). A plain server-rendered form (works without JavaScript):
 * the feed URL, how the feed is protected (nothing, an API key in the URL, a header, or a login), the schedule
 * and the country the listings are in. Credentials are write-only: on edit they are kept unless changed.
 */
const SCHEDULES = ['', '60', '360', '1440'] as const;
const CRED_TYPES = ['none', 'query', 'header', 'basic'] as const;

export interface FormPrefill {
  connector?: string | undefined;
  profile?: string | undefined;
  url?: string | undefined;
}

export async function ConnectionForm({
  connection,
  profiles = [],
  prefill = {},
}: {
  connection?: FeedConnectionDto;
  profiles?: { id: string; name: string }[];
  prefill?: FormPrefill;
}) {
  const t = await getTranslations('imports.form');
  const editing = Boolean(connection);
  const connector = connection?.connector ?? (prefill.connector === 'xml-mapped' ? 'xml-mapped' : 'kyero');
  const profile = connection?.mappingProfileId ?? prefill.profile ?? '';
  const schedule = connection?.scheduleMinutes ? String(connection.scheduleMinutes) : connection ? '' : '1440';
  const country = typeof connection?.settings.defaultCountry === 'string' ? connection.settings.defaultCountry : '';
  return (
    <form action={editing ? updateConnectionAction : createConnectionAction} className="flex max-w-xl flex-col gap-4">
      {connection ? (
        <>
          <input type="hidden" name="connectionId" value={connection.id} />
          <input type="hidden" name="version" value={connection.version} />
        </>
      ) : null}
      <div className="flex flex-col gap-2">
        <Label htmlFor="feed-format">{t('format')}</Label>
        {editing ? (
          <>
            <input type="hidden" name="connector" value={connector} />
            <p id="feed-format" className="text-sm">
              {t(`formats.${connector === 'xml-mapped' ? 'xml-mapped' : 'kyero'}`)}
            </p>
          </>
        ) : (
          <select
            id="feed-format"
            name="connector"
            defaultValue={connector}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            <option value="kyero">{t('formats.kyero')}</option>
            <option value="xml-mapped">{t('formats.xml-mapped')}</option>
          </select>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="feed-name">{t('name')}</Label>
        <Input id="feed-name" name="name" maxLength={120} required defaultValue={connection?.name ?? ''} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="feed-url">{t('url')}</Label>
        <Input
          id="feed-url"
          name="url"
          type="url"
          maxLength={2048}
          required
          placeholder="https://feeds.example.com/kyero.xml"
          defaultValue={connection?.url ?? prefill.url ?? ''}
          aria-describedby="feed-url-hint"
        />
        <p id="feed-url-hint" className="text-xs text-muted-foreground">
          {t('urlHint')}
        </p>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{t('credentials')}</legend>
        {editing ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="credType" value="keep" defaultChecked />
            {connection?.hasCredentials ? t('credTypes.keep') : t('credTypes.keepNone')}
          </label>
        ) : null}
        {CRED_TYPES.map((k) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <input type="radio" name="credType" value={k} defaultChecked={!editing && k === 'none'} />
            {t(`credTypes.${k}`)}
          </label>
        ))}
        <p className="text-xs text-muted-foreground">{t('credentialsHint')}</p>
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="cred-name">{t('credName')}</Label>
            <Input id="cred-name" name="credName" maxLength={64} autoComplete="off" placeholder="api_key" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="cred-user">{t('credUser')}</Label>
            <Input id="cred-user" name="credUser" maxLength={200} autoComplete="off" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="cred-value">{t('credValue')}</Label>
            <Input id="cred-value" name="credValue" type="password" maxLength={2000} autoComplete="new-password" />
          </div>
        </div>
      </fieldset>
      {connector === 'xml-mapped' || !editing ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="feed-profile">{t('profile')}</Label>
          <select
            id="feed-profile"
            name="mappingProfileId"
            defaultValue={profile}
            className="h-9 rounded-md border bg-background px-2 text-sm"
            aria-describedby="feed-profile-hint"
          >
            <option value="">{t('noProfile')}</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <p id="feed-profile-hint" className="text-xs text-muted-foreground">
            {t('profileHint')}{' '}
            <Link href="/imports/mapper" className="underline underline-offset-4">
              {t('openMapper')}
            </Link>
          </p>
        </div>
      ) : null}
      {connector === 'kyero' || !editing ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="feed-country">{t('country')}</Label>
          <Input
            id="feed-country"
            name="defaultCountry"
            maxLength={200}
            defaultValue={country}
            aria-describedby="feed-country-hint"
          />
          <p id="feed-country-hint" className="text-xs text-muted-foreground">
            {t('countryHint')}
          </p>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <Label htmlFor="feed-schedule">{t('schedule')}</Label>
        <select
          id="feed-schedule"
          name="scheduleMinutes"
          defaultValue={schedule}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          {SCHEDULES.map((m) => (
            <option key={m} value={m}>
              {t(`schedules.${m || 'manual'}`)}
            </option>
          ))}
        </select>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="enabled" defaultChecked={connection?.enabled ?? true} />
        {t('enabled')}
      </label>
      <div className="flex items-center gap-4">
        <Button type="submit">{editing ? t('save') : t('create')}</Button>
        <Link
          href={connection ? `/imports/${connection.id}` : '/imports'}
          className="text-sm underline-offset-4 hover:underline"
        >
          {t('cancel')}
        </Link>
      </div>
    </form>
  );
}
