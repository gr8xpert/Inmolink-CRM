import type { AgencyDto, SignupAgencyKind, SpanishRegion, UpdateAgencyDetailsBody } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { CONTENT_LOCALES, DEFAULT_CONTENT_LOCALE, isContentLocale } from '@inmolink/i18n';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { emit } from '@inmolink/platform/outbox';
import type { Ctx } from '../../context';
import { agenciesEvents } from './events';
import { assertCan } from './policy';
import * as repo from './repo';

/**
 * agencies use cases (PATTERNS §7). The agency is the tenant (PLAN §3 #1): sign-up creates one per
 * new user, PENDING until staff verify it (§3 #3, S1-03). Onboarding fills in the company details.
 */

/** Locales a new agency publishes in: the default content locale, plus the founder's if it is one. */
export function initialLocales(uiLocale: string): string[] {
  const base = uiLocale.split('-')[0] ?? uiLocale;
  return [...new Set([DEFAULT_CONTENT_LOCALE, ...(isContentLocale(base) ? [base] : [])])];
}

/**
 * Sign-up step, inside the identity module's `app_auth` transaction (no tenant session yet): the
 * caller has pinned `app.agency_id` to `agencyId` with `setAuthScope`, which is the only agency the
 * registry's `auth` predicates let it create.
 */
export async function createSignupAgency(
  tx: Tx,
  input: { agencyId: string; kind: SignupAgencyKind; name: string; uiLocale: string },
): Promise<void> {
  await repo.insertAgency(tx, {
    id: input.agencyId,
    kind: input.kind,
    name: input.name,
    enabledLocales: initialLocales(input.uiLocale),
  });
}

/**
 * A repeated sign-up for an unconfirmed email: the new details replace the pending agency's (whoever
 * controls the inbox decides, as for the password). False once it was onboarded or verified.
 */
export async function replaceSignupAgency(
  tx: Tx,
  input: { agencyId: string; kind: SignupAgencyKind; name: string },
): Promise<boolean> {
  return repo.replaceSignupAgency(tx, input.agencyId, { kind: input.kind, name: input.name }, clock.now());
}

/** What `ctx.tenant` needs. Null if the agency does not exist (or RLS hides it). */
export async function loadTenant(
  tx: Tx,
  agencyId: string,
): Promise<{ status: AgencyDto['status']; locales: string[] } | null> {
  const row = await repo.getTenantInfo(tx, agencyId);
  return row ? { status: row.status, locales: row.enabledLocales } : null;
}

/**
 * The agency's current status, locked until the transaction ends (S1-05: API keys mirror it). Takes a
 * raw `tx` like `loadTenant`: identity calls it inside its own request transaction or job. `update`
 * also serialises concurrent callers (`FOR NO KEY UPDATE`); `share` only blocks status changes.
 */
export async function lockAgencyStatus(
  tx: Tx,
  agencyId: string,
  mode: 'share' | 'update',
): Promise<AgencyDto['status'] | null> {
  return repo.lockStatus(tx, agencyId, mode);
}

/** The agency's name, for emails sent by jobs (`withSystem`; no `ctx`). */
export async function getAgencyName(tx: Tx, agencyId: string): Promise<string | null> {
  return repo.getName(tx, agencyId);
}

export function toAgencyDto(row: NonNullable<Awaited<ReturnType<typeof repo.getAgency>>>): AgencyDto {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    name: row.name,
    taxId: row.taxId,
    addressLine: row.addressLine,
    city: row.city,
    postalCode: row.postalCode,
    region: row.region as SpanishRegion | null,
    languages: row.languages,
    onboarded: row.onboardedAt !== null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The caller's own agency. */
export async function getMyAgency(ctx: Ctx): Promise<AgencyDto> {
  assertCan(ctx, 'agencies.read');
  const row = await repo.getAgency(ctx.tx, ctx.tenant.agencyId);
  if (!row) throw new AppError('NOT_FOUND');
  return toAgencyDto(row);
}

/**
 * Onboarding form (and later edits): company name, CIF/NIF, address, region, languages. Admins only.
 * Once verified, name and tax id are locked (`AGENCY_DETAILS_LOCKED`); address and languages stay editable.
 * The tax id arrives validated and normalized by the contract (Spanish control-digit rules).
 */
export async function updateAgencyDetails(ctx: Ctx, input: UpdateAgencyDetailsBody): Promise<AgencyDto> {
  assertCan(ctx, 'agencies.updateDetails');
  const unknown = input.languages.filter((l) => !isContentLocale(l));
  if (unknown.length > 0) {
    throw new AppError('VALIDATION_FAILED', {
      field: 'languages',
      unsupported: unknown,
      supported: [...CONTENT_LOCALES],
    });
  }
  const before = await repo.getDetailsState(ctx.tx, ctx.tenant.agencyId);
  if (!before) throw new AppError('NOT_FOUND');
  // Staff verified this company under its name and tax id: changing either needs re-verification
  // (S1-03), or a verified agency could take on another company's identity.
  const locked = (['name', 'taxId'] as const).filter((f) => before.status !== 'PENDING' && input[f] !== before[f]);
  if (locked.length > 0) throw new AppError('AGENCY_DETAILS_LOCKED', { fields: locked });
  const { version, ...patch } = input;
  const row = await repo.updateDetails(ctx.tx, ctx.tenant.agencyId, version, patch, clock.now());
  if (!row) throw new AppError('VERSION_CONFLICT');
  await emit(
    ctx.tx,
    agenciesEvents.detailsUpdated({
      agencyId: row.id,
      version: row.version,
      firstOnboarding: before.onboardedAt === null,
    }),
  );
  return toAgencyDto(row);
}
