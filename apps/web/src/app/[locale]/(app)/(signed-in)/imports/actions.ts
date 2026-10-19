'use server';

import {
  CreateFeedConnectionBody,
  FeedConnectionParams,
  type FeedCredentials,
  UpdateFeedConnectionBody,
} from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import {
  createFeedConnection,
  fetchFeedConnection,
  requestFeedRun,
  sessionRef,
  updateFeedConnection,
} from '@/server/api';

/**
 * Feed imports form actions (transport only, S6-01): validate with the contracts, call the API, and come back to
 * the page the form was on with a notice or an error code (i18n keys under `imports`). Plain forms: they work
 * without JavaScript.
 */
const KNOWN_ERRORS = [
  'FORBIDDEN',
  'FEED_RUN_ACTIVE',
  'FEED_CONNECTION_DISABLED',
  'FEED_CONNECTION_NOT_FOUND',
  'VALIDATION_FAILED',
  'FEED_URL_NOT_ALLOWED',
  'VERSION_CONFLICT',
  'FEED_CONNECTOR_UNKNOWN',
  'FEED_MAPPING_REQUIRED',
  'FEED_MAPPING_INVALID',
  'FEED_MAPPING_PROFILE_NOT_FOUND',
] as const;

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

/** The formats a connection can be created with from this form. */
const CONNECTORS = new Set(['kyero', 'xml-mapped']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCHEDULES = new Set(['60', '360', '1440']);
const scheduleOf = (form: FormData) => {
  const v = text(form, 'scheduleMinutes');
  return SCHEDULES.has(v) ? Number(v) : null;
};

/** The credentials a form sends: `keep` (edit only) is undefined, `none` removes them. */
function credentialsOf(form: FormData): FeedCredentials | null | undefined {
  const value = form.get('credValue');
  const secret = typeof value === 'string' ? value : '';
  switch (text(form, 'credType')) {
    case 'query':
      return { type: 'query', name: text(form, 'credName'), value: secret };
    case 'header':
      return { type: 'header', name: text(form, 'credName'), value: secret };
    case 'basic':
      return { type: 'basic', username: text(form, 'credUser'), password: secret };
    case 'keep':
      return undefined;
    case 'none':
      return null;
    default:
      // A missing or unknown choice must not wipe stored credentials: the contract refuses this shape.
      return { type: 'invalid' } as unknown as FeedCredentials;
  }
}

/** Kyero connection settings: the country the listings are in when the feed does not say (v3 has none). */
const kyeroSettings = (form: FormData) => {
  const country = text(form, 'defaultCountry');
  return country ? { defaultCountry: country } : {};
};

export async function runNowAction(form: FormData): Promise<void> {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  const params = FeedConnectionParams.safeParse({ id: form.get('connectionId') });
  const id = params.success ? params.data.id : null;
  const path = getPathname({
    href: id && form.get('from') === 'detail' ? `/imports/${id}` : '/imports',
    locale: await getLocale(),
  });
  const back = (query: Record<string, string>): never => redirect(`${path}?${new URLSearchParams(query)}`);
  if (!id) return back({ error: 'VALIDATION_FAILED' });
  const res = await requestFeedRun(sessionRef(s.user), id);
  if (res === 'revoked') redirect('/session/expired');
  if (res.ok) return back({ done: 'queued' });
  return back({ error: KNOWN_ERRORS.find((c) => c === res.error?.code) ?? 'generic' });
}

/** Connect a feed: Kyero, or generic XML with a mapping profile (admins): back to the list on success, to the form with the error code otherwise. */
export async function createConnectionAction(form: FormData): Promise<void> {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  const locale = await getLocale();
  const to = (href: string, query: Record<string, string>): never =>
    redirect(`${getPathname({ href, locale })}?${new URLSearchParams(query)}`);
  const connector = CONNECTORS.has(text(form, 'connector')) ? text(form, 'connector') : 'kyero';
  const profile = UUID.test(text(form, 'mappingProfileId')) ? text(form, 'mappingProfileId') : undefined;
  const parsed = CreateFeedConnectionBody.safeParse({
    name: text(form, 'name'),
    connector,
    url: text(form, 'url'),
    credentials: credentialsOf(form),
    settings: connector === 'kyero' ? kyeroSettings(form) : {},
    ...(profile ? { mappingProfileId: profile } : {}),
    scheduleMinutes: scheduleOf(form),
    enabled: form.get('enabled') === 'on',
  });
  if (!parsed.success) return to('/imports/new', { error: 'VALIDATION_FAILED' });
  const res = await createFeedConnection(sessionRef(s.user), parsed.data);
  if (res === 'revoked') redirect('/session/expired');
  if (res.ok) return to('/imports', { done: 'created' });
  return to('/imports/new', { error: KNOWN_ERRORS.find((c) => c === res.error?.code) ?? 'generic' });
}

/** Change a feed (admins). Stored settings are kept; only the Kyero ones are replaced. */
export async function updateConnectionAction(form: FormData): Promise<void> {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  const locale = await getLocale();
  const to = (href: string, query: Record<string, string>): never =>
    redirect(`${getPathname({ href, locale })}?${new URLSearchParams(query)}`);
  const params = FeedConnectionParams.safeParse({ id: form.get('connectionId') });
  if (!params.success) return to('/imports', { error: 'VALIDATION_FAILED' });
  const id = params.data.id;
  const session = sessionRef(s.user);
  const current = await fetchFeedConnection(session, id);
  if (current === 'revoked') redirect('/session/expired');
  if (!current.ok) return to('/imports', { error: KNOWN_ERRORS.find((c) => c === current.error?.code) ?? 'generic' });
  const { defaultCountry: _replaced, ...otherSettings } = current.data.settings;
  const parsed = UpdateFeedConnectionBody.safeParse({
    version: Number(text(form, 'version')),
    name: text(form, 'name'),
    url: text(form, 'url'),
    credentials: credentialsOf(form),
    settings: current.data.connector === 'kyero' ? { ...otherSettings, ...kyeroSettings(form) } : current.data.settings,
    ...(current.data.connector === 'xml-mapped' && UUID.test(text(form, 'mappingProfileId'))
      ? { mappingProfileId: text(form, 'mappingProfileId') }
      : {}),
    scheduleMinutes: scheduleOf(form),
    enabled: form.get('enabled') === 'on',
  });
  if (!parsed.success) return to(`/imports/${id}/edit`, { error: 'VALIDATION_FAILED' });
  const res = await updateFeedConnection(session, id, parsed.data);
  if (res === 'revoked') redirect('/session/expired');
  if (res.ok) return to(`/imports/${id}`, { done: 'saved' });
  return to(`/imports/${id}/edit`, { error: KNOWN_ERRORS.find((c) => c === res.error?.code) ?? 'generic' });
}
