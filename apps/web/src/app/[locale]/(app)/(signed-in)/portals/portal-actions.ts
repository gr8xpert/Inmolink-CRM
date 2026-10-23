'use server';

import {
  CreatePortalConnectionBody,
  PortalConnectionParams,
  SetPortalOverridesBody,
  UpdatePortalConnectionBody,
} from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import {
  type ApiResult,
  createPortalConnection,
  deletePortalConnection,
  revokePortalConnectionToken,
  rotatePortalConnectionToken,
  type SessionRef,
  sessionRef,
  setPortalOverrides,
  updatePortalConnection,
} from '@/server/api';
import { type IssuedTokenState, PORTAL_ERRORS, type PortalError } from './portal-state';

/**
 * Portal connection form actions (transport only, S9-01): read the form, validate with the contracts, call the API,
 * and come back with a notice or an error code (i18n keys under `portals`). The feed token comes back to the form
 * once (never in a URL, cookie or log). Authorization is the API's (agency admins change, members read).
 */
async function session(): Promise<SessionRef> {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  return sessionRef(s.user);
}

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

function errorOf(res: Exclude<ApiResult<unknown>, 'revoked'>): PortalError {
  if (res.ok) return 'generic';
  return PORTAL_ERRORS.find((c) => c === res.error?.code) ?? 'generic';
}

/** `key=value` per line → credentials; empty → undefined. A malformed line makes the whole value invalid. */
function credentialsOf(form: FormData): Record<string, string> | undefined {
  const lines = text(form, 'credentials')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const line of lines) {
    const at = line.indexOf('=');
    out[at < 1 ? line : line.slice(0, at).trim()] = at < 1 ? '' : line.slice(at + 1).trim();
  }
  return out;
}

function selectionOf(form: FormData) {
  const mode = text(form, 'mode');
  return { mode, tag: mode === 'TAGGED' ? text(form, 'tag') : null };
}

const back = async (href: string, query: Record<string, string>): Promise<never> => {
  const locale = await getLocale();
  return redirect(`${getPathname({ href, locale })}?${new URLSearchParams(query)}`);
};

export async function createPortalAction(_prev: IssuedTokenState, form: FormData): Promise<IssuedTokenState> {
  const parsed = CreatePortalConnectionBody.safeParse({
    channelCode: text(form, 'channelCode'),
    name: text(form, 'name'),
    selection: selectionOf(form),
    credentials: credentialsOf(form),
  });
  if (!parsed.success) return { error: 'VALIDATION_FAILED' };
  const res = await createPortalConnection(await session(), parsed.data);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) return { error: errorOf(res) };
  return { token: res.data.token, connectionId: res.data.connection.id };
}

export async function rotateTokenAction(_prev: IssuedTokenState, form: FormData): Promise<IssuedTokenState> {
  const params = PortalConnectionParams.safeParse({ connectionId: form.get('connectionId') });
  if (!params.success) return { error: 'generic' };
  const res = await rotatePortalConnectionToken(await session(), params.data.connectionId);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) return { error: errorOf(res) };
  return { token: res.data.token, connectionId: res.data.connection.id };
}

const idOf = (form: FormData) => PortalConnectionParams.safeParse({ connectionId: form.get('connectionId') });

/** Change name, on/off, rule and credentials, on the version the form was loaded with. */
export async function updatePortalAction(form: FormData): Promise<void> {
  const params = idOf(form);
  if (!params.success) return back('/portals', { error: 'VALIDATION_FAILED' });
  const id = params.data.connectionId;
  const credentials = text(form, 'removeCredentials') === 'on' ? null : credentialsOf(form);
  const parsed = UpdatePortalConnectionBody.safeParse({
    version: Number(text(form, 'version')),
    name: text(form, 'name'),
    enabled: form.get('enabled') === 'on',
    selection: selectionOf(form),
    ...(credentials === undefined ? {} : { credentials }),
  });
  if (!parsed.success) return back(`/portals/${id}`, { error: 'VALIDATION_FAILED' });
  const res = await updatePortalConnection(await session(), id, parsed.data);
  if (res === 'revoked') redirect('/session/expired');
  return back(`/portals/${id}`, res.ok ? { done: 'saved' } : { error: errorOf(res) });
}

export async function revokeTokenAction(form: FormData): Promise<void> {
  const params = idOf(form);
  if (!params.success) return back('/portals', { error: 'VALIDATION_FAILED' });
  const id = params.data.connectionId;
  const res = await revokePortalConnectionToken(await session(), id);
  if (res === 'revoked') redirect('/session/expired');
  return back(`/portals/${id}`, res.ok ? { done: 'revoked' } : { error: errorOf(res) });
}

export async function deletePortalAction(form: FormData): Promise<void> {
  const params = idOf(form);
  if (!params.success) return back('/portals', { error: 'VALIDATION_FAILED' });
  const res = await deletePortalConnection(await session(), params.data.connectionId);
  if (res === 'revoked') redirect('/session/expired');
  return back('/portals', res.ok ? { done: 'deleted' } : { error: errorOf(res) });
}

/**
 * Include, exclude or clear listings by reference (one per line, at most 200): one request, the API resolves the
 * references (one unknown reference refuses all of them, `LISTING_NOT_FOUND`).
 */
export async function choosePropertiesAction(form: FormData): Promise<void> {
  const params = idOf(form);
  if (!params.success) return back('/portals', { error: 'VALIDATION_FAILED' });
  const id = params.data.connectionId;
  const action = text(form, 'action');
  if (action !== 'INCLUDE' && action !== 'EXCLUDE' && action !== 'CLEAR') {
    return back(`/portals/${id}`, { error: 'VALIDATION_FAILED' });
  }
  const refs = [
    ...new Set(
      text(form, 'refs')
        .split(/[s,;]+/)
        .filter(Boolean)
        .map((r) => r.toUpperCase()),
    ),
  ];
  const parsed = SetPortalOverridesBody.safeParse({
    items: refs.map((ref) => ({ ref, action: action === 'CLEAR' ? null : action })),
  });
  if (!parsed.success) return back(`/portals/${id}`, { error: 'VALIDATION_FAILED' });
  const res = await setPortalOverrides(await session(), id, parsed.data);
  if (res === 'revoked') redirect('/session/expired');
  return back(`/portals/${id}`, res.ok ? { done: 'chosen' } : { error: errorOf(res) });
}

/** Clear one listing's choice (the × next to it). */
export async function clearPropertyAction(form: FormData): Promise<void> {
  const params = idOf(form);
  const propertyId = text(form, 'propertyId');
  if (!params.success) return back('/portals', { error: 'VALIDATION_FAILED' });
  const id = params.data.connectionId;
  const res = await setPortalOverrides(await session(), id, { items: [{ propertyId, action: null }] });
  if (res === 'revoked') redirect('/session/expired');
  return back(`/portals/${id}`, res.ok ? { done: 'chosen' } : { error: errorOf(res) });
}
