// Staging readers of the legacy load scripts (S4-04; reused by S14-02). The extract (S14-01, `extract-lib.ts`)
// writes `<dir>/agency-<legacy id>/<entity>.ndjson` and `<dir>/inventory.json`; the loaders read them back here.
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Inventory } from './extract-lib';

/** The extract's inventory, or null when the directory has none (counts are then checked against the staging). */
export function readInventory(dir: string): Inventory | null {
  const file = join(resolve(dir), 'inventory.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Inventory) : null;
}

const AGENCY_ID = /^[A-Za-z0-9_.-]{1,100}$/;

/** The agency directory of a legacy agency (ids as the extract wrote them; anything else is refused). */
export function agencyDir(dir: string, legacyAgencyId: string): string {
  if (!AGENCY_ID.test(legacyAgencyId)) throw new TypeError(`unsafe legacy agency id ${JSON.stringify(legacyAgencyId)}`);
  return join(resolve(dir), `agency-${legacyAgencyId}`);
}

/**
 * Every staged row of one entity of one agency, in file order. A missing file is no rows; a line that is not JSON is
 * kept as `null`, so the loader lists it as an invalid row (`#<line>`) rather than dropping it.
 */
export async function readStaged(dir: string, legacyAgencyId: string, entity: string): Promise<unknown[]> {
  if (!/^[a-z0-9_]+$/i.test(entity)) throw new TypeError(`invalid entity name ${entity}`);
  const file = join(agencyDir(dir, legacyAgencyId), `${entity}.ndjson`);
  if (!existsSync(file)) return [];
  const rows: unknown[] = [];
  const lines = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      rows.push(null);
    }
  }
  return rows;
}

/** The legacy agencies of a staging directory: the inventory's, else the `agency-*` directories. */
export function stagedAgencies(dir: string, inventory: Inventory | null): string[] {
  if (inventory) return inventory.agencies.map((a) => a.agencyId);
  const root = resolve(dir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('agency-'))
    .map((e) => e.name.slice('agency-'.length))
    .filter((id) => AGENCY_ID.test(id))
    .sort();
}

/** The inventory's legacy row count of one entity of one agency, or undefined when not inventoried. */
export function legacyRowsOf(inventory: Inventory | null, legacyAgencyId: string, entity: string): number | undefined {
  return inventory?.agencies.find((a) => a.agencyId === legacyAgencyId)?.entities[entity]?.legacyRows;
}

/** `--agency 12` or `--agency 12=<v2 agency uuid>` → legacy id and the v2 agency given for it. */
export function parseAgencyArg(arg: string): { legacyAgencyId: string; agencyId?: string } {
  const [legacyAgencyId = '', agencyId] = arg.split('=', 2).map((s) => s.trim());
  if (!AGENCY_ID.test(legacyAgencyId)) throw new TypeError(`--agency: invalid legacy agency id ${JSON.stringify(arg)}`);
  if (agencyId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agencyId)) {
    throw new TypeError(`--agency: ${JSON.stringify(agencyId)} is not an agency id (uuid)`);
  }
  return agencyId === undefined ? { legacyAgencyId } : { legacyAgencyId, agencyId: agencyId.toLowerCase() };
}
