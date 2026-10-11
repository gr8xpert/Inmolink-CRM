import {
  AgencyDto,
  ErrorBody,
  type InvitableRole,
  InviteDto,
  type InviteMemberInput,
  InvitePage,
  MeDto,
  MemberDto,
  MemberPage,
  type UpdateAgencyDetailsInput,
} from '@inmolink/contracts';
import { authCtx } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { z } from 'zod';
import { webConfig } from './env';

const logger = createLogger({ service: 'web' });

/** The signed-in user, as the web session knows them. */
export interface SessionRef {
  userId: string;
  sessionVersion: number;
}

/** An api access token already minted for this render (several calls, one mint). */
interface Token {
  token: string;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: ErrorBody['error'] | null }
  /** The session can no longer mint tokens (password reset, deactivation): end it. */
  | 'revoked';

/**
 * Server-side call to the dashboard API as the signed-in user: mints a 15-minute api token from the
 * session and calls `path`. Responses are parsed with the contract schema. The typed SDK client
 * replaces the raw fetch once `pnpm sdk:generate` exists.
 */
async function apiRequest<S extends z.ZodType>(
  session: SessionRef | Token,
  path: string,
  schema: S,
  init: { method?: 'GET' | 'PUT' | 'POST' | 'DELETE'; body?: unknown } = {},
): Promise<ApiResult<z.infer<S>>> {
  const config = await webConfig();
  try {
    const token =
      'token' in session
        ? session.token
        : (await identity.issueAccessToken(authCtx(newId()), { ...session, audience: 'api' })).token;
    const res = await fetch(`${config.API_URL}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status >= 500 || res.status === 401) logger.warn({ status: res.status, path }, 'api refused the call');
      const parsed = ErrorBody.safeParse(json);
      return { ok: false, status: res.status, error: parsed.success ? parsed.data.error : null };
    }
    return { ok: true, data: schema.parse(json) };
  } catch (err) {
    if (isAppError(err) && err.code === 'SESSION_REVOKED') return 'revoked';
    logger.error({ err, path }, 'api call failed');
    return { ok: false, status: 0, error: null };
  }
}

/** `GET /v1/me`; null when the API refused or failed. */
export async function fetchMe(userId: string, sessionVersion: number): Promise<MeDto | 'revoked' | null> {
  const res = await apiRequest({ userId, sessionVersion }, '/v1/me', MeDto);
  if (res === 'revoked') return res;
  return res.ok ? res.data : null;
}

/**
 * The dashboard home: `/v1/me` and `/v1/agency` with one minted token, called in parallel. The
 * agency is null for users without one (staff) or when the API refused.
 */
export async function fetchHome(
  session: SessionRef,
): Promise<'revoked' | { me: MeDto | null; agency: AgencyDto | null }> {
  let token: string;
  try {
    ({ token } = await identity.issueAccessToken(authCtx(newId()), { ...session, audience: 'api' }));
  } catch (err) {
    if (isAppError(err) && err.code === 'SESSION_REVOKED') return 'revoked';
    logger.error({ err }, 'access token mint failed');
    return { me: null, agency: null };
  }
  const [me, agency] = await Promise.all([
    apiRequest({ token }, '/v1/me', MeDto),
    apiRequest({ token }, '/v1/agency', AgencyDto),
  ]);
  return {
    me: me !== 'revoked' && me.ok ? me.data : null,
    agency: agency !== 'revoked' && agency.ok ? agency.data : null,
  };
}

export function fetchMyAgency(session: SessionRef): Promise<ApiResult<AgencyDto>> {
  return apiRequest(session, '/v1/agency', AgencyDto);
}

export function saveAgencyDetails(session: SessionRef, body: UpdateAgencyDetailsInput): Promise<ApiResult<AgencyDto>> {
  return apiRequest(session, '/v1/agency/details', AgencyDto, { method: 'PUT', body });
}

/**
 * The team page (S1-02): members and, for admins, open invites — one minted token, two calls in
 * parallel. `invites` is null when the API refused them (not an admin).
 */
export async function fetchTeam(
  session: SessionRef,
): Promise<'revoked' | { members: Exclude<ApiResult<MemberPage>, 'revoked'>; invites: InvitePage | null }> {
  let token: string;
  try {
    ({ token } = await identity.issueAccessToken(authCtx(newId()), { ...session, audience: 'api' }));
  } catch (err) {
    if (isAppError(err) && err.code === 'SESSION_REVOKED') return 'revoked';
    logger.error({ err }, 'access token mint failed');
    return { members: { ok: false, status: 0, error: null }, invites: null };
  }
  const [members, invites] = await Promise.all([
    apiRequest({ token }, '/v1/members?limit=100', MemberPage),
    apiRequest({ token }, '/v1/invites?limit=100', InvitePage),
  ]);
  if (members === 'revoked') return 'revoked';
  return { members, invites: invites !== 'revoked' && invites.ok ? invites.data : null };
}

export function inviteMember(session: SessionRef, body: InviteMemberInput): Promise<ApiResult<InviteDto>> {
  return apiRequest(session, '/v1/invites', InviteDto, { method: 'POST', body });
}

export function revokeInvite(session: SessionRef, inviteId: string): Promise<ApiResult<null>> {
  return apiRequest(session, `/v1/invites/${encodeURIComponent(inviteId)}`, z.null(), { method: 'DELETE' });
}

export function changeMemberRole(
  session: SessionRef,
  userId: string,
  role: InvitableRole,
): Promise<ApiResult<MemberDto>> {
  return apiRequest(session, `/v1/members/${encodeURIComponent(userId)}/role`, MemberDto, {
    method: 'PUT',
    body: { role },
  });
}

export function deactivateMember(session: SessionRef, userId: string): Promise<ApiResult<MemberDto>> {
  return apiRequest(session, `/v1/members/${encodeURIComponent(userId)}/deactivate`, MemberDto, { method: 'POST' });
}
