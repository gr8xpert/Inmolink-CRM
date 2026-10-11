import type { Tx } from '@inmolink/db';
import { agencies, agencySettings } from '@inmolink/db/schema/agencies';
import { and, eq, or, sql } from 'drizzle-orm';

/**
 * agencies queries (PATTERNS §5). Runs as `app_user` under `withTenant` for dashboard work, and as
 * `app_auth` inside the sign-up transaction (registry `auth` predicates pin it to the new agency).
 * Queries only `@inmolink/db/schema/agencies`.
 */

const dtoColumns = {
  id: agencies.id,
  kind: agencies.kind,
  status: agencies.status,
  name: agencies.name,
  taxId: agencies.taxId,
  addressLine: agencies.addressLine,
  city: agencies.city,
  postalCode: agencies.postalCode,
  region: agencies.region,
  languages: agencies.languages,
  onboardedAt: agencies.onboardedAt,
  version: agencies.version,
  updatedAt: agencies.updatedAt,
};

/** The agency row and its settings row, created together (sign-up). */
export async function insertAgency(
  tx: Tx,
  row: { id: string; kind: 'AGENCY' | 'DEVELOPER'; name: string; enabledLocales: string[] },
): Promise<void> {
  await tx.insert(agencies).values({ id: row.id, kind: row.kind, name: row.name });
  await tx.insert(agencySettings).values({ agencyId: row.id, enabledLocales: row.enabledLocales });
}

/**
 * A repeated sign-up for an unconfirmed email takes over the agency it created, while that agency is
 * still PENDING and not onboarded. Returns false when it no longer qualifies.
 */
export async function replaceSignupAgency(
  tx: Tx,
  id: string,
  patch: { kind: 'AGENCY' | 'DEVELOPER'; name: string },
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(agencies)
    .set({ ...patch, version: sql`${agencies.version} + 1`, updatedAt: now })
    .where(and(eq(agencies.id, id), eq(agencies.status, 'PENDING'), sql`${agencies.onboardedAt} is null`))
    .returning({ id: agencies.id });
  return rows.length === 1;
}

export async function getAgency(tx: Tx, id: string) {
  const [row] = await tx.select(dtoColumns).from(agencies).where(eq(agencies.id, id));
  return row ?? null;
}

export async function getName(tx: Tx, id: string): Promise<string | null> {
  const [row] = await tx.select({ name: agencies.name }).from(agencies).where(eq(agencies.id, id));
  return row?.name ?? null;
}

/** What a request `ctx` needs about its tenant: one indexed join on the agency's primary key. */
export async function getTenantInfo(tx: Tx, id: string) {
  const [row] = await tx
    .select({ status: agencies.status, enabledLocales: agencySettings.enabledLocales })
    .from(agencies)
    .innerJoin(agencySettings, eq(agencySettings.agencyId, agencies.id))
    .where(eq(agencies.id, id));
  return row ?? null;
}

/** What an edit of the company details needs to know about the current row. */
export async function getDetailsState(tx: Tx, id: string) {
  const [row] = await tx
    .select({ status: agencies.status, name: agencies.name, taxId: agencies.taxId, onboardedAt: agencies.onboardedAt })
    .from(agencies)
    .where(eq(agencies.id, id));
  return row ?? null;
}

/**
 * Company details (onboarding). Optimistic: null when `version` is stale. Sets `onboarded_at` once.
 * Name and tax id change only while PENDING (the row filter re-checks what the service decided).
 */
export async function updateDetails(
  tx: Tx,
  id: string,
  version: number,
  patch: {
    name: string;
    taxId: string;
    addressLine: string;
    city: string;
    postalCode: string;
    region: string;
    languages: string[];
  },
  now: Date,
) {
  const [row] = await tx
    .update(agencies)
    .set({
      ...patch,
      onboardedAt: sql`coalesce(${agencies.onboardedAt}, ${now})`,
      version: sql`${agencies.version} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(agencies.id, id),
        eq(agencies.version, version),
        or(eq(agencies.status, 'PENDING'), and(eq(agencies.name, patch.name), eq(agencies.taxId, patch.taxId))),
      ),
    )
    .returning(dtoColumns);
  return row ?? null;
}
