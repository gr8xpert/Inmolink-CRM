import type { Tx } from '@inmolink/db';
import { agencyProfiles, agencySettings, agencyTranslations } from '@inmolink/db/schema/agencies';
import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';

/**
 * Profile and settings queries (S1-06, PATTERNS §5). Runs as `app_user` under `withTenant`; queries only
 * `@inmolink/db/schema/agencies`. Every write is optimistic on the row's `version` (null when stale).
 */

// ── Settings ────────────────────────────────────────────────────────────────────────────────────

const settingsColumns = {
  enabledLocales: agencySettings.enabledLocales,
  registrationValidityDays: agencySettings.registrationValidityDays,
  defaultCommissionType: agencySettings.defaultCommissionType,
  defaultCommissionBp: agencySettings.defaultCommissionBp,
  defaultCommissionFixedCents: agencySettings.defaultCommissionFixedCents,
  defaultCommissionCurrency: agencySettings.defaultCommissionCurrency,
  defaultCommissionIncludesVat: agencySettings.defaultCommissionIncludesVat,
  defaultSplitBp: agencySettings.defaultSplitBp,
  viewingResponseDays: agencySettings.viewingResponseDays,
  whiteLabelReferencePrefix: agencySettings.whiteLabelReferencePrefix,
  whiteLabelShowPoweredBy: agencySettings.whiteLabelShowPoweredBy,
  whiteLabelEmailSenderName: agencySettings.whiteLabelEmailSenderName,
  clientModePinMinLength: agencySettings.clientModePinMinLength,
  clientModePinMaxAttempts: agencySettings.clientModePinMaxAttempts,
  version: agencySettings.version,
  updatedAt: agencySettings.updatedAt,
};

export interface SettingsRow {
  enabledLocales: string[];
  registrationValidityDays: number;
  defaultCommissionType: 'PCT' | 'FIXED';
  defaultCommissionBp: number | null;
  defaultCommissionFixedCents: number | null;
  defaultCommissionCurrency: string | null;
  defaultCommissionIncludesVat: boolean;
  defaultSplitBp: number;
  viewingResponseDays: number;
  whiteLabelReferencePrefix: string | null;
  whiteLabelShowPoweredBy: boolean;
  whiteLabelEmailSenderName: string | null;
  clientModePinMinLength: number;
  clientModePinMaxAttempts: number;
  version: number;
  updatedAt: Date;
}

export type SettingsPatch = Omit<SettingsRow, 'version' | 'updatedAt'>;

/** The agency's settings row (primary key lookup). */
export async function getSettings(tx: Tx, agencyId: string): Promise<SettingsRow | null> {
  const [row] = await tx.select(settingsColumns).from(agencySettings).where(eq(agencySettings.agencyId, agencyId));
  return row ?? null;
}

export async function updateSettings(
  tx: Tx,
  agencyId: string,
  version: number,
  patch: SettingsPatch,
  now: Date,
): Promise<SettingsRow | null> {
  const [row] = await tx
    .update(agencySettings)
    .set({ ...patch, version: sql`${agencySettings.version} + 1`, updatedAt: now })
    .where(and(eq(agencySettings.agencyId, agencyId), eq(agencySettings.version, version)))
    .returning(settingsColumns);
  return row ?? null;
}

// ── Profile ─────────────────────────────────────────────────────────────────────────────────────

const profileColumns = {
  logoStorageKey: agencyProfiles.logoStorageKey,
  logoContentType: agencyProfiles.logoContentType,
  logoSizeBytes: agencyProfiles.logoSizeBytes,
  logoUpdatedAt: agencyProfiles.logoUpdatedAt,
  primaryColor: agencyProfiles.primaryColor,
  accentColor: agencyProfiles.accentColor,
  contactEmail: agencyProfiles.contactEmail,
  contactPhone: agencyProfiles.contactPhone,
  websiteUrl: agencyProfiles.websiteUrl,
  version: agencyProfiles.version,
  updatedAt: agencyProfiles.updatedAt,
};

export interface ProfileRow {
  logoStorageKey: string | null;
  logoContentType: string | null;
  logoSizeBytes: number | null;
  logoUpdatedAt: Date | null;
  primaryColor: string | null;
  accentColor: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  websiteUrl: string | null;
  version: number;
  updatedAt: Date;
}

export interface ProfilePatch {
  primaryColor: string | null;
  accentColor: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  websiteUrl: string | null;
}

export interface LogoPatch {
  logoStorageKey: string | null;
  logoContentType: string | null;
  logoSizeBytes: number | null;
  logoUpdatedAt: Date | null;
}

/** Null until the agency's first profile save. */
export async function getProfile(tx: Tx, agencyId: string): Promise<ProfileRow | null> {
  const [row] = await tx.select(profileColumns).from(agencyProfiles).where(eq(agencyProfiles.agencyId, agencyId));
  return row ?? null;
}

/** The current profile row, locked until the transaction ends (logo replace / remove). */
export async function lockProfile(tx: Tx, agencyId: string): Promise<ProfileRow | null> {
  const [row] = await tx
    .select(profileColumns)
    .from(agencyProfiles)
    .where(eq(agencyProfiles.agencyId, agencyId))
    .for('no key update');
  return row ?? null;
}

/** First save (`version` 0): creates the row; null when another save created it meanwhile. */
export async function insertProfile(
  tx: Tx,
  agencyId: string,
  patch: Partial<ProfilePatch & LogoPatch>,
  now: Date,
): Promise<ProfileRow | null> {
  const [row] = await tx
    .insert(agencyProfiles)
    .values({ agencyId, ...patch, createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: agencyProfiles.agencyId })
    .returning(profileColumns);
  return row ?? null;
}

export async function updateProfile(
  tx: Tx,
  agencyId: string,
  version: number,
  patch: Partial<ProfilePatch & LogoPatch>,
  now: Date,
): Promise<ProfileRow | null> {
  const [row] = await tx
    .update(agencyProfiles)
    .set({ ...patch, version: sql`${agencyProfiles.version} + 1`, updatedAt: now })
    .where(and(eq(agencyProfiles.agencyId, agencyId), eq(agencyProfiles.version, version)))
    .returning(profileColumns);
  return row ?? null;
}

// ── Translations ────────────────────────────────────────────────────────────────────────────────

export interface TranslationRow {
  locale: string;
  tagline: string | null;
  description: string | null;
}

/** All of the agency's texts (one per content locale: bounded by the locale config). */
export async function listTranslations(tx: Tx, agencyId: string): Promise<TranslationRow[]> {
  return tx
    .select({
      locale: agencyTranslations.locale,
      tagline: agencyTranslations.tagline,
      description: agencyTranslations.description,
    })
    .from(agencyTranslations)
    .where(eq(agencyTranslations.agencyId, agencyId))
    .orderBy(asc(agencyTranslations.locale))
    .limit(50);
}

/** Replaces the agency's texts with `rows`: upserts those, deletes every other locale (two statements). */
export async function replaceTranslations(tx: Tx, agencyId: string, rows: TranslationRow[], now: Date): Promise<void> {
  const locales = rows.map((r) => r.locale);
  await tx
    .delete(agencyTranslations)
    .where(
      and(
        eq(agencyTranslations.agencyId, agencyId),
        locales.length > 0 ? notInArray(agencyTranslations.locale, locales) : undefined,
      ),
    );
  if (rows.length === 0) return;
  await tx
    .insert(agencyTranslations)
    .values(rows.map((r) => ({ agencyId, ...r, updatedAt: now })))
    .onConflictDoUpdate({
      target: [agencyTranslations.agencyId, agencyTranslations.locale],
      set: {
        tagline: sql`excluded.tagline`,
        description: sql`excluded.description`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}

/** Maintenance (`app_system`, one row per agency): which of these logo keys a profile still points to. */
export async function existingLogoKeys(tx: Tx, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await tx
    .select({ key: agencyProfiles.logoStorageKey })
    .from(agencyProfiles)
    .where(inArray(agencyProfiles.logoStorageKey, keys));
  return new Set(rows.flatMap((r) => (r.key ? [r.key] : [])));
}
