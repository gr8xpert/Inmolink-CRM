import {
  AGENCY_LOGO_MAX_BYTES,
  AGENCY_LOGO_TYPES,
  type AgencyProfileDto,
  type AgencySettingsDto,
  type ClientModePolicy,
  type Commission,
  type SignedUrlDto,
  type UpdateAgencyProfileBody,
  type UpdateAgencySettingsBody,
} from '@inmolink/contracts';
import { CONTENT_LOCALES, isContentLocale } from '@inmolink/i18n';
import { type CacheKey, cache, cacheKey } from '@inmolink/platform/cache';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { detectFileType, storage } from '@inmolink/platform/storage';
import type { Ctx, CtxRunner } from '../../context';
import * as compliance from '../compliance';
import { agenciesEvents } from './events';
import { assertCan } from './policy';
import * as repo from './settings-repo';

/**
 * Agency profile and settings (S1-06, PLAN §6 Identity, §3 #6 #7 #8 #56).
 *
 * Settings are read by other modules through `getAgencySettings` (cached in redis-cache, per agency,
 * TTL ≤ 5 min, versioned tag). Every change emits `agencies.settings.changed` in the same transaction;
 * its subscriber bumps the agency's tag, so every process misses on its next read. Misses are never
 * cached. The dashboard reads (`getMyAgencySettings`, the profile) go to the database: the admin who
 * just saved sees the new values at once.
 */

// ── Settings cache ──────────────────────────────────────────────────────────────────────────────

export const AGENCY_SETTINGS_CACHE_TTL_SECONDS = 300;

export function agencySettingsCacheKey(agencyId: string): CacheKey {
  return cacheKey({ v: 3, module: 'agencies', entity: 'settings', scope: { agencyId } });
}

/**
 * The agency's settings tag. A tag version (not a plain delete) so that a read that started before the
 * change cannot store the old value after the invalidation. One Redis key per agency: bounded.
 */
export function agencySettingsCacheTag(agencyId: string): string {
  return `agencies.settings.${agencyId}`;
}

/** `agencies.settings.changed` subscriber: the next read of that agency's settings misses everywhere. */
export async function invalidateAgencySettings(agencyId: string): Promise<void> {
  await cache.invalidateTag(agencySettingsCacheTag(agencyId));
}

// ── Settings ────────────────────────────────────────────────────────────────────────────────────

function toCommission(row: repo.SettingsRow): Commission {
  if (row.defaultCommissionType === 'PCT' && row.defaultCommissionBp !== null) {
    return { type: 'PCT', basisPoints: row.defaultCommissionBp, includesVat: row.defaultCommissionIncludesVat };
  }
  if (
    row.defaultCommissionType === 'FIXED' &&
    row.defaultCommissionFixedCents !== null &&
    row.defaultCommissionCurrency !== null
  ) {
    return {
      type: 'FIXED',
      amount: { amountCents: row.defaultCommissionFixedCents, currency: row.defaultCommissionCurrency },
      includesVat: row.defaultCommissionIncludesVat,
    };
  }
  // `agency_settings_commission_ck` rules this out.
  throw new AppError('INTERNAL', { reason: 'agency_settings: inconsistent default commission' });
}

export function toSettingsDto(row: repo.SettingsRow): AgencySettingsDto {
  return {
    defaultCommission: toCommission(row),
    defaultSplitBp: row.defaultSplitBp,
    currency: row.currency,
    registrationValidityDays: row.registrationValidityDays,
    viewingResponseDays: row.viewingResponseDays,
    enabledLocales: row.enabledLocales,
    whiteLabel: {
      referencePrefix: row.whiteLabelReferencePrefix,
      showPoweredBy: row.whiteLabelShowPoweredBy,
      emailSenderName: row.whiteLabelEmailSenderName,
    },
    clientMode: { pinMinLength: row.clientModePinMinLength, pinMaxAttempts: row.clientModePinMaxAttempts },
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toSettingsPatch(input: UpdateAgencySettingsBody, current: repo.SettingsRow): repo.SettingsPatch {
  const c = input.defaultCommission;
  return {
    currency: input.currency ?? current.currency,
    enabledLocales: input.enabledLocales,
    registrationValidityDays: input.registrationValidityDays,
    defaultCommissionType: c.type,
    defaultCommissionBp: c.type === 'PCT' ? c.basisPoints : null,
    defaultCommissionFixedCents: c.type === 'FIXED' ? c.amount.amountCents : null,
    defaultCommissionCurrency: c.type === 'FIXED' ? c.amount.currency : null,
    defaultCommissionIncludesVat: c.includesVat,
    defaultSplitBp: input.defaultSplitBp,
    viewingResponseDays: input.viewingResponseDays,
    whiteLabelReferencePrefix: input.whiteLabel.referencePrefix,
    whiteLabelShowPoweredBy: input.whiteLabel.showPoweredBy,
    whiteLabelEmailSenderName: input.whiteLabel.emailSenderName,
    clientModePinMinLength: input.clientMode.pinMinLength,
    clientModePinMaxAttempts: input.clientMode.pinMaxAttempts,
  };
}

const SETTINGS_FIELDS = [
  'defaultCommission',
  'defaultSplitBp',
  'currency',
  'registrationValidityDays',
  'viewingResponseDays',
  'enabledLocales',
  'whiteLabel',
  'clientMode',
] as const;

/** Top-level settings fields that differ between two DTOs. */
function changedFields(before: AgencySettingsDto, after: AgencySettingsDto): string[] {
  return SETTINGS_FIELDS.filter((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]));
}

/**
 * Settings other modules may read and pass on (registration validity, viewing deadlines, locales,
 * white-label). No commission, split or Client Mode PIN policy: they are not even in the type, so a
 * client-facing serializer cannot leak them by accident (S2-F2). `getAgencyDefaultCommission`
 * (policy-checked) returns commission and split, `getClientModePolicy` (internal) the PIN policy.
 */
export type AgencySettings = Omit<AgencySettingsDto, 'defaultCommission' | 'defaultSplitBp' | 'clientMode'>;

/** A new listing's commission defaults (PLAN §3 #7): the total and the collaborating agent's share. */
export interface AgencyCommissionDefaults {
  commission: Commission;
  splitBp: number;
}

/**
 * Transactions that wrote the agency's settings: their reads bypass the shared cache, so an uncommitted
 * (possibly rolled back) value is never cached for other requests. Keyed by the `tx` object, which
 * lives only as long as the transaction.
 */
const settingsWrittenIn = new WeakSet<object>();

/** The full settings, cached per agency (TTL ≤ 5 min, versioned tag); loaded under `ctx`'s RLS. */
async function loadSettings(ctx: Ctx): Promise<AgencySettingsDto> {
  const agencyId = ctx.tenant.agencyId;
  const fromDb = async () => {
    const row = await repo.getSettings(ctx.tx, agencyId);
    return row ? toSettingsDto(row) : undefined;
  };
  const settings = settingsWrittenIn.has(ctx.tx)
    ? await fromDb()
    : await cache.get(
        agencySettingsCacheKey(agencyId),
        { ttlSeconds: AGENCY_SETTINGS_CACHE_TTL_SECONDS, tags: [agencySettingsCacheTag(agencyId)] },
        // `undefined` is never cached: a missing row always goes to the database.
        fromDb,
      );
  if (!settings) throw new AppError('NOT_FOUND');
  return settings;
}

/**
 * The agency's settings for other modules, cached, without commission. An internal read (no policy):
 * callers authorize their own use case. Loaded under `ctx`'s RLS and cached under that agency only.
 */
export async function getAgencySettings(ctx: Ctx): Promise<AgencySettings> {
  const {
    defaultCommission: _commission,
    defaultSplitBp: _split,
    clientMode: _clientMode,
    ...settings
  } = await loadSettings(ctx);
  return settings;
}

/**
 * The agency's Client Mode PIN policy (PLAN §3 #56) for the one server-side consumer, the Client Mode PIN
 * check (Client Mode session task; no caller before it). Internal (S2-F2): members only, never serialized
 * to a client. Same cache as `getAgencySettings`.
 */
export async function getClientModePolicy(ctx: Ctx): Promise<ClientModePolicy> {
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  return (await loadSettings(ctx)).clientMode;
}

/**
 * The agency's default commission and split (PLAN §3 #7) for agent-facing use cases (a new or imported
 * listing's defaults, S3-02): members of the agency only, never in Client Mode (`FORBIDDEN`). Same
 * cache as `getAgencySettings`.
 */
export async function getAgencyDefaultCommission(ctx: Ctx): Promise<AgencyCommissionDefaults> {
  assertCan(ctx, 'agencies.commission.read');
  const settings = await loadSettings(ctx);
  return { commission: settings.defaultCommission, splitBp: settings.defaultSplitBp };
}

/**
 * `GET /v1/agency/settings`: any member, never in Client Mode — settings hold commission and the PIN
 * policy, none of which a client may see (PLAN §3 #56).
 */
export async function getMyAgencySettings(ctx: Ctx): Promise<AgencySettingsDto> {
  assertCan(ctx, 'agencies.settings.read');
  const row = await repo.getSettings(ctx.tx, ctx.tenant.agencyId);
  if (!row) throw new AppError('NOT_FOUND');
  return toSettingsDto(row);
}

function assertContentLocales(field: string, locales: readonly string[]): void {
  const unsupported = locales.filter((l) => !isContentLocale(l));
  if (unsupported.length > 0) {
    throw new AppError('VALIDATION_FAILED', { field, unsupported, supported: [...CONTENT_LOCALES] });
  }
}

/** Whoever acted, and the staff member impersonating them, for the event (S1-08 audit); FORBIDDEN for non-users. */
function actorOf(ctx: Ctx): { actorUserId: string; impersonatedBy: string | null } {
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  return { actorUserId: ctx.actor.userId, impersonatedBy: ctx.actor.impersonatedBy ?? null };
}

/**
 * `PUT /v1/agency/settings`: admins only, not in Client Mode, not while impersonated. Optimistic on
 * `version`. A save that changes nothing writes nothing and emits nothing; any change emits
 * `agencies.settings.changed` (which invalidates the settings cache).
 */
export async function updateAgencySettings(ctx: Ctx, input: UpdateAgencySettingsBody): Promise<AgencySettingsDto> {
  assertCan(ctx, 'agencies.settings.update');
  const actor = actorOf(ctx);
  assertContentLocales('enabledLocales', input.enabledLocales);
  const agencyId = ctx.tenant.agencyId;
  const current = await repo.getSettings(ctx.tx, agencyId);
  if (!current) throw new AppError('NOT_FOUND');
  if (current.version !== input.version) throw new AppError('VERSION_CONFLICT');
  const before = toSettingsDto(current);
  const patch = toSettingsPatch(input, current);
  const changed = changedFields(before, toSettingsDto({ ...current, ...patch }));
  if (changed.length === 0) return before;

  const row = await repo.updateSettings(ctx.tx, agencyId, input.version, patch, clock.now());
  if (!row) throw new AppError('VERSION_CONFLICT');
  settingsWrittenIn.add(ctx.tx);
  await emit(ctx.tx, agenciesEvents.settingsChanged({ agencyId, version: row.version, changed, ...actor }));
  return toSettingsDto(row);
}

// ── Profile ─────────────────────────────────────────────────────────────────────────────────────

/** Signed logo links live this long (stub until S3-03 serves logo variants from the CDN). */
export const LOGO_URL_TTL_SECONDS = 300;

function toProfileDto(row: repo.ProfileRow | null, translations: repo.TranslationRow[]): AgencyProfileDto {
  const logo =
    row?.logoStorageKey && row.logoContentType && row.logoSizeBytes !== null && row.logoUpdatedAt
      ? {
          contentType: row.logoContentType as (typeof AGENCY_LOGO_TYPES)[number],
          sizeBytes: row.logoSizeBytes,
          updatedAt: row.logoUpdatedAt.toISOString(),
        }
      : null;
  return {
    logo,
    primaryColor: row?.primaryColor ?? null,
    accentColor: row?.accentColor ?? null,
    contactEmail: row?.contactEmail ?? null,
    contactPhone: row?.contactPhone ?? null,
    websiteUrl: row?.websiteUrl ?? null,
    translations,
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

/** `GET /v1/agency/profile`: any member (two primary-key queries). */
export async function getAgencyProfile(ctx: Ctx): Promise<AgencyProfileDto> {
  assertCan(ctx, 'agencies.read');
  const agencyId = ctx.tenant.agencyId;
  const row = await repo.getProfile(ctx.tx, agencyId);
  return toProfileDto(row, await repo.listTranslations(ctx.tx, agencyId));
}

const PROFILE_FIELDS = ['primaryColor', 'accentColor', 'contactEmail', 'contactPhone', 'websiteUrl'] as const;
/** Profile fields that identify the agency (S7-F5: removed from its listings' indexed text). */
const IDENTITY_FIELDS = ['contactEmail', 'contactPhone', 'websiteUrl'] as const;

/**
 * `PUT /v1/agency/profile`: admins only, not in Client Mode (staff impersonating an admin may: the event
 * records both). Optimistic on `version` (0 creates the row). The translations sent replace the others.
 * A save that changes nothing writes nothing and emits nothing.
 */
export async function updateAgencyProfile(ctx: Ctx, input: UpdateAgencyProfileBody): Promise<AgencyProfileDto> {
  assertCan(ctx, 'agencies.profile.update');
  const actor = actorOf(ctx);
  assertContentLocales(
    'translations',
    input.translations.map((t) => t.locale),
  );
  const agencyId = ctx.tenant.agencyId;
  const { version, translations, ...patch } = input;
  // Same shape and order as `repo.listTranslations` (locale ascending), for the no-op comparison.
  const texts = translations
    .filter((t) => t.tagline !== null || t.description !== null)
    .map((t) => ({ locale: t.locale, tagline: t.tagline, description: t.description }))
    .sort((a, b) => (a.locale < b.locale ? -1 : 1));
  const current = await repo.getProfile(ctx.tx, agencyId);
  if ((current?.version ?? 0) !== version) throw new AppError('VERSION_CONFLICT');
  const currentTexts = await repo.listTranslations(ctx.tx, agencyId);
  const unchanged =
    PROFILE_FIELDS.every((f) => (current?.[f] ?? null) === patch[f]) &&
    JSON.stringify(currentTexts) === JSON.stringify(texts);
  if (unchanged) return toProfileDto(current, currentTexts);

  const now = clock.now();
  const row =
    version === 0
      ? await repo.insertProfile(ctx.tx, agencyId, patch, now)
      : await repo.updateProfile(ctx.tx, agencyId, version, patch, now);
  if (!row) throw new AppError('VERSION_CONFLICT');
  await repo.replaceTranslations(ctx.tx, agencyId, texts, now);
  // S7-F5: the search index removes the published contacts from the agency's listing text.
  const identityChanged = IDENTITY_FIELDS.some((f) => (current?.[f] ?? null) !== patch[f]);
  await emit(
    ctx.tx,
    agenciesEvents.profileUpdated({ agencyId, version: row.version, logoChanged: false, identityChanged, ...actor }),
  );
  // S1-09: the profile is what staff may change while impersonating, so it is audited with both actors.
  await compliance.audit(ctx, 'agencies.profile.updated', { type: 'agency', id: agencyId }, { logoChanged: false });
  return toProfileDto(row, await repo.listTranslations(ctx.tx, agencyId));
}

/** Logo object keys: per agency, from a fresh UUIDv7, never from the file name (the CHECK on the row requires the prefix). */
const logoKey = (agencyId: string) => `agency-logos/${agencyId}/${newId()}`;

/** Swaps the logo columns on the locked row (or creates the row) and emits; returns the old key. */
async function setLogo(
  ctx: Ctx,
  logo: repo.LogoPatch,
): Promise<{ profile: AgencyProfileDto; previousKey: string | null }> {
  const agencyId = ctx.tenant.agencyId;
  const now = clock.now();
  const current = await repo.lockProfile(ctx.tx, agencyId);
  const row = current
    ? await repo.updateProfile(ctx.tx, agencyId, current.version, logo, now)
    : await repo.insertProfile(ctx.tx, agencyId, logo, now);
  if (!row) throw new AppError('VERSION_CONFLICT');
  await emit(
    ctx.tx,
    agenciesEvents.profileUpdated({
      agencyId,
      version: row.version,
      logoChanged: true,
      identityChanged: false,
      ...actorOf(ctx),
    }),
  );
  await compliance.audit(ctx, 'agencies.profile.updated', { type: 'agency', id: agencyId }, { logoChanged: true });
  return {
    profile: toProfileDto(row, await repo.listTranslations(ctx.tx, agencyId)),
    previousKey: current?.logoStorageKey ?? null,
  };
}

/**
 * Replaces the agency's logo. **Stub until the media pipeline (S3-03):** the file is checked by magic
 * bytes (PNG, JPEG, WebP) and size, then stored as uploaded in the private bucket under
 * `agency-logos/<agency>/<id>` and served through short signed URLs. S3-03 re-encodes it with sharp and
 * moves it to media variants. Checks run in a first transaction, the upload outside any transaction,
 * and a second transaction records it (re-checking); the replaced object is deleted afterwards.
 */
export async function uploadAgencyLogo(run: CtxRunner, input: { body: Uint8Array }): Promise<AgencyProfileDto> {
  if (input.body.byteLength === 0) throw new AppError('VALIDATION_FAILED', { field: 'body', reason: 'empty' });
  if (input.body.byteLength > AGENCY_LOGO_MAX_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', { maxBytes: AGENCY_LOGO_MAX_BYTES });
  }
  const type = detectFileType(input.body);
  if (!type || !(AGENCY_LOGO_TYPES as readonly string[]).includes(type.contentType)) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', { allowed: [...AGENCY_LOGO_TYPES] });
  }

  const agencyId = await run(async (ctx) => {
    // `can` refuses every actor that is not a user, so the event's actor exists in the second transaction.
    assertCan(ctx, 'agencies.profile.update');
    return ctx.tenant.agencyId;
  });
  const key = logoKey(agencyId);
  await storage().put('private', key, input.body, { contentType: type.contentType });

  let result: { profile: AgencyProfileDto; previousKey: string | null };
  try {
    result = await run(async (ctx) => {
      if (ctx.tenant.agencyId !== agencyId) throw new AppError('FORBIDDEN');
      assertCan(ctx, 'agencies.profile.update');
      return setLogo(ctx, {
        logoStorageKey: key,
        logoContentType: type.contentType,
        logoSizeBytes: input.body.byteLength,
        logoUpdatedAt: clock.now(),
      });
    });
  } catch (err) {
    await storage()
      .delete('private', key)
      .catch(() => {});
    throw err;
  }
  // A failed delete leaves an unreferenced object in a private bucket: never readable (S1-F7 sweeps).
  if (result.previousKey) {
    await storage()
      .delete('private', result.previousKey)
      .catch(() => {});
  }
  return result.profile;
}

/** Removes the logo (row first, then the object, outside the transaction). */
export async function removeAgencyLogo(run: CtxRunner): Promise<AgencyProfileDto> {
  const result = await run(async (ctx) => {
    // Authorized (an admin user, not in Client Mode) first, even when there is nothing to remove.
    assertCan(ctx, 'agencies.profile.update');
    const current = await repo.getProfile(ctx.tx, ctx.tenant.agencyId);
    if (!current?.logoStorageKey) {
      const texts = await repo.listTranslations(ctx.tx, ctx.tenant.agencyId);
      return { profile: toProfileDto(current, texts), previousKey: null };
    }
    return setLogo(ctx, { logoStorageKey: null, logoContentType: null, logoSizeBytes: null, logoUpdatedAt: null });
  });
  if (result.previousKey) {
    await storage()
      .delete('private', result.previousKey)
      .catch(() => {});
  }
  return result.profile;
}

/** A 5-minute link to the current logo, for the dashboard preview (stub until S3-03). Any member. */
export async function getAgencyLogoUrl(ctx: Ctx): Promise<SignedUrlDto> {
  assertCan(ctx, 'agencies.read');
  const agencyId = ctx.tenant.agencyId;
  const row = await repo.getProfile(ctx.tx, agencyId);
  const key = row?.logoStorageKey;
  // Defence in depth on top of the row CHECK: only this agency's logo objects are ever signed.
  if (!key?.startsWith(`agency-logos/${agencyId}/`)) throw new AppError('NOT_FOUND');
  const expiresAt = new Date(clock.now().getTime() + LOGO_URL_TTL_SECONDS * 1000);
  // Local signing only, no network I/O inside the transaction.
  // Served as the image type checked at upload, whatever the object's metadata says. (S3/R2 presigned
  // URLs cannot add `X-Content-Type-Options: nosniff`; the pinned image type is the stub's defence.)
  const url = await storage().signedGetUrl('private', key, {
    expiresInSeconds: LOGO_URL_TTL_SECONDS,
    ...(row?.logoContentType ? { responseContentType: row.logoContentType } : {}),
  });
  return { url, expiresAt: expiresAt.toISOString() };
}
