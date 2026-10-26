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
 * One staged entity file as batches of at most `size` rows, streamed line by line (one batch in memory at a time), in
 * file order on every call; undefined when the file is missing. A line that is not JSON becomes
 * `{ __unparsableLine: <line number> }`: the loader lists it as an invalid row rather than dropping it.
 */
export function stagedSource(
  dir: string,
  legacyAgencyId: string,
  entity: string,
): { batches(size: number): AsyncIterable<readonly unknown[]> } | undefined {
  if (!/^[a-z0-9_]+$/i.test(entity)) throw new TypeError(`invalid entity name ${entity}`);
  const file = join(agencyDir(dir, legacyAgencyId), `${entity}.ndjson`);
  if (!existsSync(file)) return undefined;
  return {
    async *batches(size: number) {
      const n = Math.max(1, Math.trunc(size));
      const input = createReadStream(file, { encoding: 'utf8' });
      const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
      let batch: unknown[] = [];
      let lineNo = 0;
      try {
        for await (const line of lines) {
          lineNo += 1;
          if (line.trim() === '') continue;
          try {
            batch.push(JSON.parse(line));
          } catch {
            batch.push({ __unparsableLine: lineNo });
          }
          if (batch.length >= n) {
            yield batch;
            batch = [];
          }
        }
        if (batch.length > 0) yield batch;
      } finally {
        lines.close();
        input.destroy();
      }
    },
  };
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
