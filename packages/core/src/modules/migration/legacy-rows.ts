// Helpers shared by the legacy loaders and the validation (S15-F1): staged-row ids, euros → cents and the lookup of a
// legacy agency's v2 agency. Pure except `agencyOfLegacy` (one read).
import type { Tx } from '@inmolink/db';
import * as repo from './repo';

/** The staged row's value at `key` as an id (a trimmed string or number), as a list of zero or one. */
export const idOf = (row: unknown, key: string): string[] => {
  const v = (row as Record<string, unknown> | null)?.[key];
  return typeof v === 'string' || typeof v === 'number' ? [String(v).trim()] : [];
};

/** The ids at `key` of every staged row that has one. */
export const idsOf = (rows: readonly unknown[], key: string): string[] => rows.flatMap((r) => idOf(r, key));

/** A staged row's own legacy `id`: trimmed, null when missing or blank. */
export const rowIdOf = (row: unknown): string | null => idOf(row, 'id')[0] || null;

export const cents = (euros: number) => Math.round(euros * 100);

/** The v2 agency a legacy agency was loaded as, or null when it was not loaded. */
export async function agencyOfLegacy(tx: Tx, legacyAgencyId: string): Promise<string | null> {
  return (await repo.getMaps(tx, 'agency', [legacyAgencyId])).get(legacyAgencyId)?.newId ?? null;
}
