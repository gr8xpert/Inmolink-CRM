import {
  type AddPreferredAgencyBody,
  AGENCY_LOGO_TYPES,
  AgencyDto,
  AgencyProfileDto,
  AgencySettingsDto,
  AgencyVerificationDto,
  ApiKeyPage,
  type CreateApiKeyInput,
  type DecideVerificationBody,
  DirectorySearchResult,
  ErrorBody,
  type InvitableRole,
  InviteDto,
  type InviteMemberInput,
  InvitePage,
  IssuedApiKeyDto,
  MeDto,
  MemberDto,
  MemberPage,
  PreferredAgencyDto,
  PreferredAgencyPage,
  SignedUrlDto,
  type UpdateAgencyDetailsInput,
  type UpdateAgencyProfileInput,
  type UpdateAgencySettingsInput,
  type UpdatePreferredAgencyBody,
  type UploadVerificationDocumentQuery,
  VERIFICATION_DOCUMENT_TYPES,
  VerificationDocumentDto,
  VerificationQueuePage,
  VerificationRequestDto,
  type VerificationRequestStatus,
} from '@inmolink/contracts';
import * as identity from '@inmolink/core/modules/identity';
import { isAppError } from '@inmolink/platform/errors';
import { createLogger } from '@inmolink/platform/logger';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import { getPathname } from '@/i18n/navigation';
import { webConfig } from './env';
import { requestAuthCtx } from './request-id';

const logger = createLogger({ service: 'web' });

/** The signed-in user, as the web session knows them. */
export interface SessionRef {
  userId: string;
  sessionVersion: number;
  /** The session passed the second factor (S1-04). */
  mfaVerified: boolean;
}

export function sessionRef(user: { id: string; sessionVersion: number; mfaVerified: boolean }): SessionRef {
  return { userId: user.id, sessionVersion: user.sessionVersion, mfaVerified: user.mfaVerified };
}

/**
 * The session has not passed the second factor its user needs (S1-04): no access token, so no
 * dashboard. Pages, actions and route handlers all land here, and go to the challenge (or enrolment).
 */
async function toTwoFactor(): Promise<never> {
  redirect(getPathname({ href: '/two-factor', locale: await getLocale() }));
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
  init: {
    method?: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    /** A binary body (uploads) instead of JSON. */
    raw?: { bytes: Uint8Array; contentType: string };
    timeoutMs?: number;
  } = {},
): Promise<ApiResult<z.infer<S>>> {
  const config = await webConfig();
  try {
    const token =
      'token' in session
        ? session.token
        : (await identity.issueAccessToken(await requestAuthCtx(), { ...session, audience: 'api' })).token;
    const res = await fetch(`${config.API_URL}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.raw
          ? { 'content-type': init.raw.contentType }
          : init.body === undefined
            ? {}
            : { 'content-type': 'application/json' }),
      },
      body: init.raw
        ? (init.raw.bytes as Uint8Array<ArrayBuffer>)
        : init.body === undefined
          ? undefined
          : JSON.stringify(init.body),
      cache: 'no-store',
      signal: AbortSignal.timeout(init.timeoutMs ?? 5_000),
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
    if (isAppError(err) && err.code === 'MFA_REQUIRED') return toTwoFactor();
    logger.error({ err, path }, 'api call failed');
    return { ok: false, status: 0, error: null };
  }
}

/** `GET /v1/me`; null when the API refused or failed. */
export async function fetchMe(session: SessionRef): Promise<MeDto | 'revoked' | null> {
  const res = await apiRequest(session, '/v1/me', MeDto);
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
    ({ token } = await identity.issueAccessToken(await requestAuthCtx(), { ...session, audience: 'api' }));
  } catch (err) {
    if (isAppError(err) && err.code === 'SESSION_REVOKED') return 'revoked';
    if (isAppError(err) && err.code === 'MFA_REQUIRED') return toTwoFactor();
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

// ── Profile and settings (S1-06) ────────────────────────────────────────────────────────────────

export function fetchAgencyProfile(session: SessionRef): Promise<ApiResult<AgencyProfileDto>> {
  return apiRequest(session, '/v1/agency/profile', AgencyProfileDto);
}

export function saveAgencyProfile(
  session: SessionRef,
  body: UpdateAgencyProfileInput,
): Promise<ApiResult<AgencyProfileDto>> {
  return apiRequest(session, '/v1/agency/profile', AgencyProfileDto, { method: 'PUT', body });
}

export function fetchAgencyLogoUrl(session: SessionRef): Promise<ApiResult<SignedUrlDto>> {
  return apiRequest(session, '/v1/agency/profile/logo/url', SignedUrlDto);
}

/** The image goes to the API as the raw body; the API checks its real type and size. */
export function uploadAgencyLogo(
  session: SessionRef,
  file: { bytes: Uint8Array; contentType: string },
): Promise<ApiResult<AgencyProfileDto>> {
  // Only types the API's body parser accepts; anything else is sent as octet-stream and sniffed.
  const contentType = (AGENCY_LOGO_TYPES as readonly string[]).includes(file.contentType)
    ? file.contentType
    : 'application/octet-stream';
  return apiRequest(session, '/v1/agency/profile/logo', AgencyProfileDto, {
    method: 'PUT',
    raw: { bytes: file.bytes, contentType },
    timeoutMs: 15_000,
  });
}

export function removeAgencyLogo(session: SessionRef): Promise<ApiResult<AgencyProfileDto>> {
  return apiRequest(session, '/v1/agency/profile/logo', AgencyProfileDto, { method: 'DELETE' });
}

export function fetchAgencySettings(session: SessionRef): Promise<ApiResult<AgencySettingsDto>> {
  return apiRequest(session, '/v1/agency/settings', AgencySettingsDto);
}

export function saveAgencySettings(
  session: SessionRef,
  body: UpdateAgencySettingsInput,
): Promise<ApiResult<AgencySettingsDto>> {
  return apiRequest(session, '/v1/agency/settings', AgencySettingsDto, { method: 'PUT', body });
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
    ({ token } = await identity.issueAccessToken(await requestAuthCtx(), { ...session, audience: 'api' }));
  } catch (err) {
    if (isAppError(err) && err.code === 'SESSION_REVOKED') return 'revoked';
    if (isAppError(err) && err.code === 'MFA_REQUIRED') return toTwoFactor();
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

// ── Website API keys (S1-05) ────────────────────────────────────────────────────────────────────

export function fetchApiKeys(session: SessionRef): Promise<ApiResult<ApiKeyPage>> {
  return apiRequest(session, '/v1/api-keys?limit=100', ApiKeyPage);
}

/** The whole key comes back once: hand it to the page, never log or store it. */
export function createApiKey(session: SessionRef, body: CreateApiKeyInput): Promise<ApiResult<IssuedApiKeyDto>> {
  return apiRequest(session, '/v1/api-keys', IssuedApiKeyDto, { method: 'POST', body });
}

export function rotateApiKey(session: SessionRef, keyId: string): Promise<ApiResult<IssuedApiKeyDto>> {
  return apiRequest(session, `/v1/api-keys/${encodeURIComponent(keyId)}/rotate`, IssuedApiKeyDto, { method: 'POST' });
}

export function revokeApiKey(session: SessionRef, keyId: string): Promise<ApiResult<null>> {
  return apiRequest(session, `/v1/api-keys/${encodeURIComponent(keyId)}`, z.null(), { method: 'DELETE' });
}

// ── Verification (S1-03) ────────────────────────────────────────────────────────────────────────

export function fetchVerification(session: SessionRef): Promise<ApiResult<AgencyVerificationDto>> {
  return apiRequest(session, '/v1/agency/verification', AgencyVerificationDto);
}

/** The file goes to the API as the raw body; the API checks its real type and size. */
export function uploadVerificationDocument(
  session: SessionRef,
  query: UploadVerificationDocumentQuery,
  file: { bytes: Uint8Array; contentType: string },
): Promise<ApiResult<VerificationDocumentDto>> {
  const qs = new URLSearchParams({ kind: query.kind, fileName: query.fileName });
  // Only types the API's body parser accepts; anything else is sent as octet-stream and sniffed.
  const contentType = (VERIFICATION_DOCUMENT_TYPES as readonly string[]).includes(file.contentType)
    ? file.contentType
    : 'application/octet-stream';
  return apiRequest(session, `/v1/agency/verification/documents?${qs}`, VerificationDocumentDto, {
    method: 'POST',
    raw: { bytes: file.bytes, contentType },
    timeoutMs: 30_000,
  });
}

export function deleteVerificationDocument(session: SessionRef, id: string): Promise<ApiResult<null>> {
  return apiRequest(session, `/v1/agency/verification/documents/${encodeURIComponent(id)}`, z.null(), {
    method: 'DELETE',
  });
}

export function submitVerification(session: SessionRef, version: number): Promise<ApiResult<AgencyVerificationDto>> {
  return apiRequest(session, '/v1/agency/verification', AgencyVerificationDto, { method: 'POST', body: { version } });
}

export function fetchVerificationQueue(
  session: SessionRef,
  q: { status: VerificationRequestStatus; cursor?: string },
): Promise<ApiResult<VerificationQueuePage>> {
  const qs = new URLSearchParams({ status: q.status, limit: '50', ...(q.cursor ? { cursor: q.cursor } : {}) });
  return apiRequest(session, `/v1/staff/verification-requests?${qs}`, VerificationQueuePage);
}

export function fetchVerificationRequest(session: SessionRef, id: string): Promise<ApiResult<VerificationRequestDto>> {
  return apiRequest(session, `/v1/staff/verification-requests/${encodeURIComponent(id)}`, VerificationRequestDto);
}

export function fetchVerificationDocumentUrl(
  session: SessionRef,
  id: string,
  documentId: string,
): Promise<ApiResult<SignedUrlDto>> {
  return apiRequest(
    session,
    `/v1/staff/verification-requests/${encodeURIComponent(id)}/documents/${encodeURIComponent(documentId)}/url`,
    SignedUrlDto,
  );
}

export function decideVerification(
  session: SessionRef,
  id: string,
  body: DecideVerificationBody,
): Promise<ApiResult<VerificationRequestDto>> {
  return apiRequest(
    session,
    `/v1/staff/verification-requests/${encodeURIComponent(id)}/decision`,
    VerificationRequestDto,
    {
      method: 'POST',
      body,
    },
  );
}

// ── Preferred agencies (S1-07) ────────────────────────────────────────────────────────────────

export function fetchPreferredAgencies(
  session: SessionRef,
  cursor: string | undefined,
): Promise<ApiResult<PreferredAgencyPage>> {
  const query = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) });
  return apiRequest(session, `/v1/agency/preferred-agencies?${query}`, PreferredAgencyPage);
}

export function searchAgencyDirectory(session: SessionRef, q: string): Promise<ApiResult<DirectorySearchResult>> {
  return apiRequest(session, `/v1/agency-directory?${new URLSearchParams({ q })}`, DirectorySearchResult);
}

export function addPreferredAgency(
  session: SessionRef,
  body: AddPreferredAgencyBody,
): Promise<ApiResult<PreferredAgencyDto>> {
  return apiRequest(session, '/v1/agency/preferred-agencies', PreferredAgencyDto, { method: 'POST', body });
}

export function updatePreferredAgency(
  session: SessionRef,
  agencyId: string,
  body: UpdatePreferredAgencyBody,
): Promise<ApiResult<PreferredAgencyDto>> {
  return apiRequest(session, `/v1/agency/preferred-agencies/${encodeURIComponent(agencyId)}`, PreferredAgencyDto, {
    method: 'PATCH',
    body,
  });
}

export function removePreferredAgency(session: SessionRef, agencyId: string): Promise<ApiResult<null>> {
  return apiRequest(session, `/v1/agency/preferred-agencies/${encodeURIComponent(agencyId)}`, z.null(), {
    method: 'DELETE',
  });
}
