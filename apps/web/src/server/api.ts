import {
  type AddPreferredAgencyBody,
  AGENCY_LOGO_TYPES,
  AgencyDto,
  AgencyProfileDto,
  AgencySettingsDto,
  AgencyVerificationDto,
  ApiKeyPage,
  BookmarkDto,
  type BookmarkFolderBody,
  BookmarkFolderDto,
  BookmarkFolderList,
  BookmarkPage,
  type CreateApiKeyInput,
  type CreateBookmarkBody,
  type CreateListingBody,
  type DecideVerificationBody,
  DirectorySearchResult,
  ErrorBody,
  type InvitableRole,
  InviteDto,
  type InviteMemberInput,
  InvitePage,
  IssuedApiKeyDto,
  ListingBookmarkList,
  ListingBulkDto,
  ListingContentDto,
  ListingDocumentDto,
  ListingDocumentList,
  ListingDocumentUrlDto,
  ListingDto,
  type ListingFilter,
  ListingMediaList,
  ListingOverrideDto,
  ListingOverrideList,
  type ListingOverrideTarget,
  ListingPage,
  ListingQualityDto,
  type ListingSort,
  type ListingViewBody,
  ListingViewDto,
  ListingViewList,
  MeDto,
  type MediaCheckBody,
  MediaCheckResult,
  MemberDto,
  MemberPage,
  MyCapabilitiesDto,
  PreferredAgencyDto,
  PreferredAgencyPage,
  type PutListingOverrideBody,
  type PutListingTranslationBody,
  type RegisterMediaBody,
  type ReorderListingMediaBody,
  type SetListingFeaturesBody,
  SignedUrlDto,
  StaffAccessPage,
  type StartListingBulkBody,
  TaxonomyDto,
  type UpdateAgencyDetailsInput,
  type UpdateAgencyProfileInput,
  type UpdateAgencySettingsInput,
  type UpdateBookmarkBody,
  type UpdateListingBody,
  type UpdateListingMediaBody,
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
import { cache } from 'react';
import { z } from 'zod';
import { getPathname } from '@/i18n/navigation';
import { webConfig } from './env';
import { readImpersonation } from './impersonation';
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

/**
 * The staff member's impersonation session ended, expired or was revoked (S1-09): a route handler
 * forgets it in the browser and sends them back to the staff console.
 */
function toImpersonationEnded(): never {
  redirect('/session/impersonation-ended');
}

/**
 * Mints the api token for a call to `path` (S1-09): staff APIs always run as the signed-in user
 * themselves; every other call runs as the impersonated member while the staff member's session is
 * open (the mint and the API both check it is theirs and live).
 */
function mintFor(session: SessionRef, path: string): Promise<string> {
  return mintCached(session.userId, session.sessionVersion, session.mfaVerified, path.startsWith('/v1/staff/'));
}

/**
 * One mint per render and audience (S1-10 review): the shell, the layout and the page share the token.
 * `cache` lives for one request and is keyed by primitives, so every caller hits the same entry; a
 * failed mint (revoked session, second factor owed) is thrown again to each of them.
 */
const mintCached = cache(
  async (userId: string, sessionVersion: number, mfaVerified: boolean, staffPath: boolean): Promise<string> => {
    const impersonation = staffPath ? null : await readImpersonation(userId);
    const { token } = await identity.issueAccessToken(await requestAuthCtx(), {
      userId,
      sessionVersion,
      mfaVerified,
      audience: 'api',
      ...(impersonation ? { impersonationId: impersonation.id } : {}),
    });
    return token;
  },
);

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
export async function apiRequest<S extends z.ZodType>(
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
  const result = await apiCall(config.API_URL, session, path, schema, init);
  if (result !== 'revoked' && !result.ok && result.error?.code === 'IMPERSONATION_ENDED') toImpersonationEnded();
  return result;
}

async function apiCall<S extends z.ZodType>(
  apiUrl: string,
  session: SessionRef | Token,
  path: string,
  schema: S,
  init: NonNullable<Parameters<typeof apiRequest>[3]>,
): Promise<ApiResult<z.infer<S>>> {
  try {
    const token = 'token' in session ? session.token : await mintFor(session, path);
    const res = await fetch(`${apiUrl}${path}`, {
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
    if (isAppError(err) && err.code === 'IMPERSONATION_ENDED') {
      return { ok: false, status: 403, error: { code: err.code, message: err.code } };
    }
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

/** `GET /v1/me/capabilities` (S1-10): the member's role and the dashboard sections they may open. */
export function fetchMyCapabilities(session: SessionRef): Promise<ApiResult<MyCapabilitiesDto>> {
  return apiRequest(session, '/v1/me/capabilities', MyCapabilitiesDto);
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
    token = await mintFor(session, '/v1/me');
  } catch (err) {
    if (isAppError(err) && err.code === 'SESSION_REVOKED') return 'revoked';
    if (isAppError(err) && err.code === 'MFA_REQUIRED') return toTwoFactor();
    if (isAppError(err) && err.code === 'IMPERSONATION_ENDED') toImpersonationEnded();
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
    token = await mintFor(session, '/v1/members');
  } catch (err) {
    if (isAppError(err) && err.code === 'SESSION_REVOKED') return 'revoked';
    if (isAppError(err) && err.code === 'MFA_REQUIRED') return toTwoFactor();
    if (isAppError(err) && err.code === 'IMPERSONATION_ENDED') toImpersonationEnded();
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

// ── Staff access record (S1-F9) ─────────────────────────────────────────────────────────────────

/** When Inmolink staff acted as a member of this agency, and why (admins only; others get 403). */
export function fetchStaffAccess(session: SessionRef, cursor?: string): Promise<ApiResult<StaffAccessPage>> {
  const qs = new URLSearchParams({ limit: '50', ...(cursor ? { cursor } : {}) });
  return apiRequest(session, `/v1/staff-access?${qs}`, StaffAccessPage);
}

// ── Listings (S3-05) ──────────────────────────────────────────────────────────────────────────

/** The listing list's query (S3-07): filters, sort and cursor, as the API names them. */
export interface ListingsQuery {
  filter: ListingFilter;
  sort: ListingSort;
  cursor: string | undefined;
}

function listingsPath(q: ListingsQuery): string {
  const qs = new URLSearchParams({ limit: '50' });
  for (const [key, value] of Object.entries(q.filter)) {
    if (value !== undefined && value !== '' && value !== false) qs.set(key, String(value));
  }
  if (q.sort !== 'newest') qs.set('sort', q.sort);
  if (q.cursor) qs.set('cursor', q.cursor);
  return `/v1/listings?${qs}`;
}

/**
 * The listings page (S3-07): a page of listings, the taxonomy, the caller's saved views and the team (owner
 * names, the assign picker) with one minted token, in parallel. Everything but the listings is null when refused.
 */
export async function fetchListingsPage(
  session: SessionRef,
  q: ListingsQuery,
): Promise<
  | 'revoked'
  | {
      listings: Exclude<ApiResult<ListingPage>, 'revoked'>;
      taxonomy: TaxonomyDto | null;
      views: ListingViewList | null;
      members: MemberDto[] | null;
    }
> {
  let token: string;
  try {
    token = await mintFor(session, '/v1/listings');
  } catch (err) {
    if (isAppError(err) && err.code === 'SESSION_REVOKED') return 'revoked';
    if (isAppError(err) && err.code === 'MFA_REQUIRED') return toTwoFactor();
    if (isAppError(err) && err.code === 'IMPERSONATION_ENDED') toImpersonationEnded();
    logger.error({ err }, 'access token mint failed');
    return { listings: { ok: false, status: 0, error: null }, taxonomy: null, views: null, members: null };
  }
  const [listings, taxonomy, views, members] = await Promise.all([
    apiRequest({ token }, listingsPath(q), ListingPage),
    apiRequest({ token }, '/v1/taxonomy', TaxonomyDto),
    apiRequest({ token }, '/v1/listing-views', ListingViewList),
    apiRequest({ token }, '/v1/members?limit=100', MemberPage),
  ]);
  if (listings === 'revoked') return 'revoked';
  const ok = <T>(r: ApiResult<T>) => (r !== 'revoked' && r.ok ? r.data : null);
  return { listings, taxonomy: ok(taxonomy), views: ok(views), members: ok(members)?.items ?? null };
}

export function createListingView(session: SessionRef, body: ListingViewBody): Promise<ApiResult<ListingViewDto>> {
  return apiRequest(session, '/v1/listing-views', ListingViewDto, { method: 'POST', body });
}

export function deleteListingView(session: SessionRef, id: string): Promise<ApiResult<null>> {
  return apiRequest(session, `/v1/listing-views/${encodeURIComponent(id)}`, z.null(), { method: 'DELETE' });
}

export function startListingBulkAction(
  session: SessionRef,
  body: StartListingBulkBody,
): Promise<ApiResult<ListingBulkDto>> {
  return apiRequest(session, '/v1/listing-bulk-actions', ListingBulkDto, { method: 'POST', body });
}

export function fetchListingBulkAction(session: SessionRef, id: string): Promise<ApiResult<ListingBulkDto>> {
  return apiRequest(session, `/v1/listing-bulk-actions/${encodeURIComponent(id)}`, ListingBulkDto);
}

/** The localized taxonomy (types, locations, features) for the listing forms. */
export function fetchTaxonomy(session: SessionRef): Promise<ApiResult<TaxonomyDto>> {
  return apiRequest(session, '/v1/taxonomy', TaxonomyDto);
}

/**
 * The listing editor: the listing, its content, the taxonomy and its media with one minted token, in parallel.
 * `taxonomy` is null when the API refused it (the editor then shows ids only).
 */
export async function fetchListingEditor(
  session: SessionRef,
  id: string,
): Promise<
  | 'revoked'
  | {
      listing: Exclude<ApiResult<ListingDto>, 'revoked'>;
      content: ListingContentDto | null;
      taxonomy: TaxonomyDto | null;
      media: ListingMediaList | null;
      quality: ListingQualityDto | null;
    }
> {
  let token: string;
  try {
    token = await mintFor(session, '/v1/listings');
  } catch (err) {
    if (isAppError(err) && err.code === 'SESSION_REVOKED') return 'revoked';
    if (isAppError(err) && err.code === 'MFA_REQUIRED') return toTwoFactor();
    if (isAppError(err) && err.code === 'IMPERSONATION_ENDED') toImpersonationEnded();
    logger.error({ err }, 'access token mint failed');
    return {
      listing: { ok: false, status: 0, error: null },
      content: null,
      taxonomy: null,
      media: null,
      quality: null,
    };
  }
  const path = `/v1/listings/${encodeURIComponent(id)}`;
  const [listing, content, taxonomy, media, quality] = await Promise.all([
    apiRequest({ token }, path, ListingDto),
    apiRequest({ token }, `${path}/content`, ListingContentDto),
    apiRequest({ token }, '/v1/taxonomy', TaxonomyDto),
    apiRequest({ token }, `${path}/media`, ListingMediaList),
    apiRequest({ token }, `${path}/quality`, ListingQualityDto),
  ]);
  if (listing === 'revoked') return 'revoked';
  return {
    listing,
    content: content !== 'revoked' && content.ok ? content.data : null,
    taxonomy: taxonomy !== 'revoked' && taxonomy.ok ? taxonomy.data : null,
    media: media !== 'revoked' && media.ok ? media.data : null,
    quality: quality !== 'revoked' && quality.ok ? quality.data : null,
  };
}

/** The listing's quality score and fix-it hints (S3-08), computed now; refused for other agencies' listings. */
export function fetchListingQuality(session: SessionRef, id: string): Promise<ApiResult<ListingQualityDto>> {
  return apiRequest(session, `/v1/listings/${encodeURIComponent(id)}/quality`, ListingQualityDto);
}

/** The listing is still on the market (S3-08): restarts the 90/120-day clock. */
export function confirmListing(session: SessionRef, id: string): Promise<ApiResult<ListingDto>> {
  return apiRequest(session, `/v1/listings/${encodeURIComponent(id)}/confirm`, ListingDto, { method: 'POST' });
}

export function createListing(session: SessionRef, body: CreateListingBody): Promise<ApiResult<ListingDto>> {
  return apiRequest(session, '/v1/listings', ListingDto, { method: 'POST', body });
}

export function updateListing(
  session: SessionRef,
  id: string,
  body: UpdateListingBody,
): Promise<ApiResult<ListingDto>> {
  return apiRequest(session, `/v1/listings/${encodeURIComponent(id)}`, ListingDto, { method: 'PATCH', body });
}

export function putListingTranslation(
  session: SessionRef,
  id: string,
  locale: string,
  body: PutListingTranslationBody,
): Promise<ApiResult<ListingContentDto>> {
  return apiRequest(
    session,
    `/v1/listings/${encodeURIComponent(id)}/translations/${encodeURIComponent(locale)}`,
    ListingContentDto,
    { method: 'PUT', body },
  );
}

export function deleteListingTranslation(
  session: SessionRef,
  id: string,
  locale: string,
  version: number,
): Promise<ApiResult<ListingContentDto>> {
  return apiRequest(
    session,
    `/v1/listings/${encodeURIComponent(id)}/translations/${encodeURIComponent(locale)}?version=${version}`,
    ListingContentDto,
    { method: 'DELETE' },
  );
}

export function setListingFeatures(
  session: SessionRef,
  id: string,
  body: SetListingFeaturesBody,
): Promise<ApiResult<ListingContentDto>> {
  return apiRequest(session, `/v1/listings/${encodeURIComponent(id)}/features`, ListingContentDto, {
    method: 'PUT',
    body,
  });
}

// --- listing media (S3-06) ---------------------------------------------------------------------------------

/** Which files (by SHA-256) are stored already, and signed upload URLs for the others. */
export function checkMedia(session: SessionRef, body: MediaCheckBody): Promise<ApiResult<MediaCheckResult>> {
  return apiRequest(session, '/v1/media/check', MediaCheckResult, { method: 'POST', body });
}

/** Attaches uploaded (or stored) files to a listing; registering verifies new uploads in storage. */
export function registerMedia(session: SessionRef, body: RegisterMediaBody): Promise<ApiResult<ListingMediaList>> {
  return apiRequest(session, '/v1/media/register', ListingMediaList, { method: 'POST', body, timeoutMs: 30_000 });
}

export function listListingMedia(session: SessionRef, id: string): Promise<ApiResult<ListingMediaList>> {
  return apiRequest(session, `/v1/listings/${encodeURIComponent(id)}/media`, ListingMediaList);
}

export function updateListingMedia(
  session: SessionRef,
  id: string,
  mediaId: string,
  body: UpdateListingMediaBody,
): Promise<ApiResult<ListingMediaList>> {
  return apiRequest(
    session,
    `/v1/listings/${encodeURIComponent(id)}/media/${encodeURIComponent(mediaId)}`,
    ListingMediaList,
    { method: 'PATCH', body },
  );
}

export function reorderListingMedia(
  session: SessionRef,
  id: string,
  body: ReorderListingMediaBody,
): Promise<ApiResult<ListingMediaList>> {
  return apiRequest(session, `/v1/listings/${encodeURIComponent(id)}/media/order`, ListingMediaList, {
    method: 'PUT',
    body,
  });
}

export function detachListingMedia(session: SessionRef, id: string, mediaId: string): Promise<ApiResult<null>> {
  return apiRequest(session, `/v1/listings/${encodeURIComponent(id)}/media/${encodeURIComponent(mediaId)}`, z.null(), {
    method: 'DELETE',
  });
}

/** A YouTube, Vimeo or Matterport link, last in the listing's media (S3-F5). */
export function addListingVideo(session: SessionRef, id: string, url: string): Promise<ApiResult<ListingMediaList>> {
  return apiRequest(session, `/v1/listings/${encodeURIComponent(id)}/videos`, ListingMediaList, {
    method: 'POST',
    body: { url },
  });
}

// --- listing documents (S3-F5): private to the agency ---

export function listListingDocuments(session: SessionRef, id: string): Promise<ApiResult<ListingDocumentList>> {
  return apiRequest(session, `/v1/listings/${encodeURIComponent(id)}/documents`, ListingDocumentList);
}

/** One PDF as a raw body; the API checks its real type by magic bytes. */
export function uploadListingDocument(
  session: SessionRef,
  id: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<ApiResult<ListingDocumentDto>> {
  const qs = new URLSearchParams({ fileName });
  return apiRequest(session, `/v1/listings/${encodeURIComponent(id)}/documents?${qs}`, ListingDocumentDto, {
    method: 'POST',
    raw: { bytes, contentType: 'application/pdf' },
    timeoutMs: 60_000,
  });
}

export function openListingDocument(
  session: SessionRef,
  id: string,
  documentId: string,
): Promise<ApiResult<ListingDocumentUrlDto>> {
  return apiRequest(
    session,
    `/v1/listings/${encodeURIComponent(id)}/documents/${encodeURIComponent(documentId)}/url`,
    ListingDocumentUrlDto,
  );
}

export function deleteListingDocument(session: SessionRef, id: string, documentId: string): Promise<ApiResult<null>> {
  return apiRequest(
    session,
    `/v1/listings/${encodeURIComponent(id)}/documents/${encodeURIComponent(documentId)}`,
    z.null(),
    { method: 'DELETE' },
  );
}

// ---- Bookmarks (S3-09) ----

/**
 * The bookmarks page: the caller's folders, the taxonomy (type and location names) and, when a folder is open,
 * a page of its bookmarks — one minted token, in parallel. `bookmarks` is null without an open folder.
 */
export async function fetchBookmarksPage(
  session: SessionRef,
  folderId: string | undefined,
  cursor: string | undefined,
): Promise<
  | 'revoked'
  | {
      folders: Exclude<ApiResult<BookmarkFolderList>, 'revoked'>;
      bookmarks: Exclude<ApiResult<BookmarkPage>, 'revoked'> | null;
      taxonomy: TaxonomyDto | null;
    }
> {
  let token: string;
  try {
    token = await mintFor(session, '/v1/bookmark-folders');
  } catch (err) {
    if (isAppError(err) && err.code === 'SESSION_REVOKED') return 'revoked';
    if (isAppError(err) && err.code === 'MFA_REQUIRED') return toTwoFactor();
    if (isAppError(err) && err.code === 'IMPERSONATION_ENDED') toImpersonationEnded();
    logger.error({ err }, 'access token mint failed');
    return { folders: { ok: false, status: 0, error: null }, bookmarks: null, taxonomy: null };
  }
  const qs = new URLSearchParams({ limit: '50', ...(cursor ? { cursor } : {}) });
  const [folders, bookmarks, taxonomy] = await Promise.all([
    apiRequest({ token }, '/v1/bookmark-folders', BookmarkFolderList),
    folderId
      ? apiRequest({ token }, `/v1/bookmark-folders/${encodeURIComponent(folderId)}/bookmarks?${qs}`, BookmarkPage)
      : Promise.resolve(null),
    apiRequest({ token }, '/v1/taxonomy', TaxonomyDto),
  ]);
  if (folders === 'revoked' || bookmarks === 'revoked') return 'revoked';
  return { folders, bookmarks, taxonomy: taxonomy !== 'revoked' && taxonomy.ok ? taxonomy.data : null };
}

export function fetchBookmarkFolders(session: SessionRef): Promise<ApiResult<BookmarkFolderList>> {
  return apiRequest(session, '/v1/bookmark-folders', BookmarkFolderList);
}

export function createBookmarkFolder(
  session: SessionRef,
  body: BookmarkFolderBody,
): Promise<ApiResult<BookmarkFolderDto>> {
  return apiRequest(session, '/v1/bookmark-folders', BookmarkFolderDto, { method: 'POST', body });
}

export function renameBookmarkFolder(
  session: SessionRef,
  id: string,
  body: BookmarkFolderBody,
): Promise<ApiResult<BookmarkFolderDto>> {
  return apiRequest(session, `/v1/bookmark-folders/${encodeURIComponent(id)}`, BookmarkFolderDto, {
    method: 'PUT',
    body,
  });
}

export function deleteBookmarkFolder(session: SessionRef, id: string): Promise<ApiResult<null>> {
  return apiRequest(session, `/v1/bookmark-folders/${encodeURIComponent(id)}`, z.null(), { method: 'DELETE' });
}

/** Which of the caller's folders hold this listing (the editor's bookmark button). */
export function fetchListingBookmarks(session: SessionRef, listingId: string): Promise<ApiResult<ListingBookmarkList>> {
  return apiRequest(session, `/v1/listings/${encodeURIComponent(listingId)}/bookmarks`, ListingBookmarkList);
}

export function createBookmark(session: SessionRef, body: CreateBookmarkBody): Promise<ApiResult<BookmarkDto>> {
  return apiRequest(session, '/v1/bookmarks', BookmarkDto, { method: 'POST', body });
}

export function updateBookmark(
  session: SessionRef,
  id: string,
  body: UpdateBookmarkBody,
): Promise<ApiResult<BookmarkDto>> {
  return apiRequest(session, `/v1/bookmarks/${encodeURIComponent(id)}`, BookmarkDto, { method: 'PATCH', body });
}

export function deleteBookmark(session: SessionRef, id: string): Promise<ApiResult<null>> {
  return apiRequest(session, `/v1/bookmarks/${encodeURIComponent(id)}`, z.null(), { method: 'DELETE' });
}

// ---- Listing overrides (S3-10): the agency's own text for a listing it presents ----------------------------

const overridePath = (kind: ListingOverrideTarget, id: string) =>
  `/v1/listing-overrides/${kind}/${encodeURIComponent(id)}`;

export function fetchListingOverrides(
  session: SessionRef,
  kind: ListingOverrideTarget,
  id: string,
): Promise<ApiResult<ListingOverrideList>> {
  return apiRequest(session, overridePath(kind, id), ListingOverrideList);
}

export function putListingOverride(
  session: SessionRef,
  kind: ListingOverrideTarget,
  id: string,
  locale: string,
  body: PutListingOverrideBody,
): Promise<ApiResult<ListingOverrideDto>> {
  return apiRequest(session, `${overridePath(kind, id)}/${encodeURIComponent(locale)}`, ListingOverrideDto, {
    method: 'PUT',
    body,
  });
}

export function deleteListingOverride(
  session: SessionRef,
  kind: ListingOverrideTarget,
  id: string,
  locale: string,
): Promise<ApiResult<null>> {
  return apiRequest(session, `${overridePath(kind, id)}/${encodeURIComponent(locale)}`, z.null(), {
    method: 'DELETE',
  });
}
