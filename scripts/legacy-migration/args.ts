// Argument parsing shared by the legacy operator scripts (S15-F1): `--map <entities.json>` and `--agency`.
import { readFileSync } from 'node:fs';
import type { EntitySpec, Inventory } from './extract-lib';
import { parseAgencyArg, stagedAgencies } from './staging';

/** `--map <entities.json>`: the extract's entity specs from a file; undefined when the flag is absent. */
export function readEntityMap(path: string | undefined): EntitySpec[] | undefined {
  return path ? (JSON.parse(readFileSync(path, 'utf8')) as EntitySpec[]) : undefined;
}

/**
 * `--agency <legacy id>[=<v2 agency uuid>]...` against a staging directory: the v2 agency given per legacy agency, and
 * the agencies to process (the ones named, else every staged one). No agency at all is a usage error.
 */
export function stagedAgencyArgs(
  args: readonly string[] | undefined,
  staging: string,
  inventory: Inventory | null,
): { given: Map<string, string | undefined>; agencies: string[] } {
  const given = new Map((args ?? []).map(parseAgencyArg).map((a) => [a.legacyAgencyId, a.agencyId]));
  const agencies = given.size > 0 ? [...given.keys()] : stagedAgencies(staging, inventory);
  if (agencies.length === 0) throw new TypeError(`no staged agency under ${staging}`);
  return { given, agencies };
}
