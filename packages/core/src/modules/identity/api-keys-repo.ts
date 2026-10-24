import type { Tx } from '@inmolink/db';
import { apiKeys } from '@inmolink/db/schema/identity';
import { and, count, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfterRaw, keysetOrderRaw, keysetStamp } from '../../pagination';

/**
 * `api_keys` queries (S1-05, PATTERNS §5). Kept apart from `repo.ts` (size). Runs as `app_user` under
 * `withTenant` (dashboard), `app_public` under `withPublicRead` (feed-api lookup by prefix) and
 * `app_system` in the identity jobs.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ApiKeyKind = (typeof apiKeys.$inferSelect)['kind'];
export type ApiKeyRateTier = (typeof apiKeys.$inferSelect)['rateTier'];

const listColumns = {
  atUs: keysetStamp(apiKeys.createdAt),
  id: apiKeys.id,
  name: apiKeys.name,
  kind: apiKeys.kind,
  prefix: apiKeys.prefix,
  scopes: apiKeys.scopes,
  allowedOrigins: apiKeys.allowedOrigins,
  rateTier: apiKeys.rateTier,
  siteId: apiKeys.siteId,
  lastUsedAt: apiKeys.lastUsedAt,
  createdAt: apiKeys.createdAt,
  rotatedAt: apiKeys.rotatedAt,
  revokedAt: apiKeys.revokedAt,
};

export interface ApiKeyRow {
  /** `keysetStamp` of the sort time: the exact cursor of the list. */
  atUs: string;
  id: string;
  name: string;
  kind: ApiKeyKind;
  prefix: string;
  scopes: string[];
  allowedOrigins: string[];
  rateTier: ApiKeyRateTier;
  siteId: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

export async function insertApiKey(
  tx: Tx,
  row: {
    id: string;
    agencyId: string;
    name: string;
    kind: ApiKeyKind;
    prefix: string;
    keyHash: string;
    scopes: string[];
    allowedOrigins: string[];
    rateTier: ApiKeyRateTier;
    siteId: string;
    agencyActive: boolean;
    createdBy: string;
    createdAt: Date;
  },
): Promise<ApiKeyRow> {
  const [inserted] = await tx
    .insert(apiKeys)
    .values({ ...row, updatedAt: row.createdAt })
    .returning(listColumns);
  if (!inserted) throw new Error('insertApiKey: no row returned');
  return inserted;
}

/** Active keys of the agency (the cap). Uses `api_keys_agency_created_idx`; at most a few dozen rows. */
export async function countActiveApiKeys(tx: Tx, agencyId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(apiKeys)
    .where(and(eq(apiKeys.agencyId, agencyId), isNull(apiKeys.revokedAt)));
  return row?.n ?? 0;
}

/**
 * The agency's keys, oldest first (keyset on `(created_at, id)`): active ones and those revoked after
 * `revokedSince` (older revoked keys are history the dashboard no longer lists).
 */
export async function listApiKeys(
  tx: Tx,
  agencyId: string,
  revokedSince: Date,
  q: { limit: number; cursor?: KeysetCursor },
): Promise<ApiKeyRow[]> {
  return await apiKeysPageQuery(tx, agencyId, revokedSince, q);
}

/** The statement of `listApiKeys`, not yet run (the EXPLAIN test runs the repo's own query). */
export function apiKeysPageQuery(
  tx: Tx,
  agencyId: string,
  revokedSince: Date,
  q: { limit: number; cursor?: KeysetCursor },
) {
  return tx
    .select(listColumns)
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.agencyId, agencyId),
        or(isNull(apiKeys.revokedAt), gt(apiKeys.revokedAt, revokedSince)),
        keysetAfterRaw(apiKeys.createdAt, apiKeys.id, q.cursor, 'asc'),
      ),
    )
    .orderBy(...keysetOrderRaw(apiKeys.createdAt, apiKeys.id, 'asc'))
    .limit(q.limit + 1);
}

/** An active key of the agency, locked for rotation. */
export async function lockActiveApiKey(
  tx: Tx,
  agencyId: string,
  id: string,
): Promise<{ prefix: string; kind: ApiKeyKind } | null> {
  const [row] = await tx
    .select({ prefix: apiKeys.prefix, kind: apiKeys.kind })
    .from(apiKeys)
    .where(and(eq(apiKeys.agencyId, agencyId), eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .for('update');
  return row ?? null;
}

export async function rotateApiKey(
  tx: Tx,
  agencyId: string,
  id: string,
  next: { prefix: string; keyHash: string },
  now: Date,
): Promise<ApiKeyRow | null> {
  const [row] = await tx
    .update(apiKeys)
    .set({ prefix: next.prefix, keyHash: next.keyHash, rotatedAt: now, updatedAt: now })
    .where(and(eq(apiKeys.agencyId, agencyId), eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning(listColumns);
  return row ?? null;
}

/** Revokes an active key; returns its prefix, or null when there is no such active key. */
export async function revokeApiKey(
  tx: Tx,
  agencyId: string,
  id: string,
  revokedBy: string,
  now: Date,
): Promise<{ prefix: string } | null> {
  const [row] = await tx
    .update(apiKeys)
    .set({ revokedAt: now, revokedBy, updatedAt: now })
    .where(and(eq(apiKeys.agencyId, agencyId), eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning({ prefix: apiKeys.prefix });
  return row ?? null;
}

/** Sets the rate tier of the agency's active keys among `ids` (S7-08). Answers the keys changed. */
export async function setApiKeyRateTier(
  tx: Tx,
  agencyId: string,
  ids: readonly string[],
  tier: ApiKeyRateTier,
  now: Date,
): Promise<{ id: string; prefix: string }[]> {
  if (ids.length === 0) return [];
  return tx
    .update(apiKeys)
    .set({ rateTier: tier, updatedAt: now })
    .where(and(eq(apiKeys.agencyId, agencyId), inArray(apiKeys.id, [...ids]), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id, prefix: apiKeys.prefix });
}

export interface ApiKeyAuthRow {
  id: string;
  agencyId: string;
  kind: ApiKeyKind;
  keyHash: string;
  scopes: string[];
  allowedOrigins: string[];
  rateTier: ApiKeyRateTier;
  /** Null only for keys created before sites existed (S7-01). */
  siteId: string | null;
  /** S8-02: may be sent as the v1 shim's legacy query parameter. */
  legacyQueryKey: boolean;
}

/**
 * Website API auth (`app_public`): the usable key with this prefix — RLS (`public_read`) hides revoked
 * keys and keys of agencies that are not verified. Unique index on `prefix`: one index probe.
 */
export async function findUsableApiKeyByPrefix(tx: Tx, prefix: string): Promise<ApiKeyAuthRow | null> {
  const [row] = await tx
    .select({
      id: apiKeys.id,
      agencyId: apiKeys.agencyId,
      kind: apiKeys.kind,
      keyHash: apiKeys.keyHash,
      scopes: apiKeys.scopes,
      allowedOrigins: apiKeys.allowedOrigins,
      rateTier: apiKeys.rateTier,
      siteId: apiKeys.siteId,
      legacyQueryKey: apiKeys.legacyQueryKey,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.prefix, prefix), isNull(apiKeys.revokedAt), eq(apiKeys.agencyActive, true)))
    .limit(1);
  return row ?? null;
}

/**
 * Job (`app_system`): mirrors the agency's status onto its keys. Returns the prefixes of the agency's
 * active keys, whose cached lookups must be dropped.
 */
export async function setAgencyActive(tx: Tx, agencyId: string, active: boolean, now: Date): Promise<string[]> {
  await tx
    .update(apiKeys)
    .set({ agencyActive: active, updatedAt: now })
    .where(and(eq(apiKeys.agencyId, agencyId), sql`${apiKeys.agencyActive} is distinct from ${active}`));
  const rows = await tx
    .select({ prefix: apiKeys.prefix })
    .from(apiKeys)
    .where(and(eq(apiKeys.agencyId, agencyId), isNull(apiKeys.revokedAt)));
  return rows.map((r) => r.prefix);
}

/**
 * Job (`app_system`): writes drained "last used" times in one statement; a time never moves backwards.
 */
export async function recordApiKeyUse(tx: Tx, uses: { id: string; at: Date }[]): Promise<number> {
  // Ids come back from Redis: only UUIDs reach the `uuid` cast.
  const valid = uses.filter((u) => UUID_RE.test(u.id) && Number.isFinite(u.at.getTime()));
  if (valid.length === 0) return 0;
  // One JSON parameter (not one per value): the statement stays the same size for any batch.
  const rows = JSON.stringify(valid.map((u) => ({ id: u.id, at: u.at.toISOString() })));
  const res = await tx.execute(sql`
    update ${apiKeys} as k
       set last_used_at = u.at
      from jsonb_to_recordset(${rows}::jsonb) as u(id uuid, at timestamptz)
     where k.id = u.id and (k.last_used_at is null or k.last_used_at < u.at)`);
  return res.rowCount ?? 0;
}

/**
 * S8-02 (`app_system`: the legacy key import, `pnpm legacy:key-flag`): marks the active key with this prefix as a
 * migrated legacy key, or clears the mark. Answers the key changed, if any.
 */
export async function setLegacyQueryKey(
  tx: Tx,
  agencyId: string,
  prefix: string,
  enabled: boolean,
  now: Date,
): Promise<{ id: string } | null> {
  const [row] = await tx
    .update(apiKeys)
    .set({ legacyQueryKey: enabled, updatedAt: now })
    .where(and(eq(apiKeys.agencyId, agencyId), eq(apiKeys.prefix, prefix), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return row ?? null;
}
