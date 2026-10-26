// Legacy extract (S14-01, PLAN §14 Path A step 3). Reads a RESTORED COPY of the legacy dump (H1; the dump and the
// extracted files stay outside the repo) and writes deterministic NDJSON staging files per agency plus an entity
// inventory. The legacy database is only ever opened READ ONLY: the session default is read-only, the work runs in
// a `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction (one consistent snapshot), and every statement is a
// SELECT built from validated identifiers. Re-running against the same dump yields byte-identical data files.
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import {
  assertIdent,
  DEFAULT_ENTITIES,
  type EntitySpec,
  qualified,
  scope,
  validateSpecs,
} from '@inmolink/core/modules/migration';
import { type LegacySnapshot, openLegacySnapshot, stableJson } from '@inmolink/platform/legacy-db';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

// The entity specs and scope SQL live in the migration module (S15-F4), shared with the worker's delta reader.
export { DEFAULT_ENTITIES, type EntitySpec, qualified, scope, stableJson, validateSpecs };

export interface ExtractOptions {
  /** Connection string of the restored legacy copy. */
  url: string;
  /** Output root; must be outside the repository. */
  outDir: string;
  entities?: EntitySpec[];
  /** Legacy agency IDs to extract; empty/undefined = every agency. */
  agencyIds?: string[];
  /** Rows per query (keyset pages). */
  batchSize?: number;
}

export interface EntityInventory {
  /** Rows the legacy table holds for this scope (counted in the same snapshot). */
  legacyRows: number;
  /** Rows written to the staging file. */
  extractedRows: number;
  sha256: string;
}

export interface AgencyInventory {
  agencyId: string;
  entities: Record<string, EntityInventory>;
}

export interface Inventory {
  entities: string[];
  agencies: AgencyInventory[];
  totals: Record<string, number>;
  /** Tables of the legacy database that no entity spec covers (nothing is silently ignored). */
  uncoveredTables: string[];
}

/** The extract never writes into the repo (CLAUDE.md: legacy data stays outside it). */
export function assertOutsideRepo(outDir: string): string {
  const abs = resolve(outDir);
  const rel = relative(REPO_ROOT, abs);
  const outside = rel.startsWith('..') || /^[a-z]:/i.test(rel) || rel.startsWith(sep);
  if (!outside) throw new Error(`--out must be outside the repository (${abs})`);
  return abs;
}

async function extractEntity(
  client: LegacySnapshot,
  e: EntitySpec,
  byName: Map<string, EntitySpec>,
  agencyId: string,
  file: string,
  batchSize: number,
): Promise<EntityInventory> {
  const { from, where } = scope(e, byName);
  const alias = e.viaParent ? 'c' : 't';
  const idCol = `${alias}.${assertIdent(e.idColumn, 'column')}`;
  const total = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${from} WHERE ${where}`, [agencyId]);
  const limit = Math.max(1, Math.trunc(batchSize));
  const tmp = `${file}.tmp`;
  const out = createWriteStream(tmp, { encoding: 'utf8' });
  const hash = createHash('sha256');
  let written = 0;
  // A server-side cursor over the text form of the id (stable for numeric and uuid keys alike): no OFFSET.
  for await (const rows of client.stream(
    `SELECT ${alias}.* FROM ${from} WHERE ${where} ORDER BY ${idCol}::text`,
    [agencyId],
    limit,
  )) {
    for (const row of rows) {
      const line = `${stableJson(row)}\n`;
      hash.update(line);
      if (!out.write(line)) await once(out, 'drain');
      written++;
    }
  }
  out.end();
  await once(out, 'finish');
  renameSync(tmp, file);
  return { legacyRows: Number(total[0]?.n ?? 0), extractedRows: written, sha256: hash.digest('hex') };
}

/** Runs the extract. Resolves with the inventory (also written to `<out>/inventory.json`). */
export async function runExtract(opts: ExtractOptions): Promise<Inventory> {
  const entities = opts.entities ?? DEFAULT_ENTITIES;
  validateSpecs(entities);
  const byName = new Map(entities.map((e) => [e.name, e]));
  const outDir = assertOutsideRepo(opts.outDir);
  const batchSize = opts.batchSize ?? 1000;
  const agencySpec = entities.find((e) => e.isAgency) as EntitySpec;

  const client = await openLegacySnapshot({ applicationName: 'inmolink-legacy-extract', url: opts.url });
  try {
    const idList = (
      await client.query<{ id: string }>(
        `SELECT ${assertIdent(agencySpec.idColumn, 'column')}::text AS id FROM ${qualified(agencySpec)} ORDER BY 1`,
      )
    ).map((r) => r.id);
    const wanted = opts.agencyIds?.length ? opts.agencyIds : idList;
    const missing = wanted.filter((id) => !idList.includes(id));
    if (missing.length) throw new Error(`unknown legacy agency ids: ${missing.join(', ')}`);

    const agencies: AgencyInventory[] = [];
    const totals: Record<string, number> = Object.fromEntries(entities.map((e) => [e.name, 0]));
    for (const agencyId of [...wanted].sort()) {
      if (!/^[A-Za-z0-9_.-]{1,100}$/.test(agencyId))
        throw new TypeError(`unsafe legacy agency id ${JSON.stringify(agencyId)}`);
      const dir = join(outDir, `agency-${agencyId}`);
      mkdirSync(dir, { recursive: true });
      const inv: AgencyInventory = { agencyId, entities: {} };
      for (const e of entities) {
        const r = await extractEntity(client, e, byName, agencyId, join(dir, `${e.name}.ndjson`), batchSize);
        inv.entities[e.name] = r;
        totals[e.name] = (totals[e.name] ?? 0) + r.extractedRows;
      }
      agencies.push(inv);
    }

    const covered = new Set(entities.map((e) => `${e.schema ?? 'public'}.${e.table}`));
    const tables = await client.query<{ s: string; t: string }>(
      `SELECT table_schema AS s, table_name AS t FROM information_schema.tables
       WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2`,
    );
    const uncoveredTables = tables.map((r) => `${r.s}.${r.t}`).filter((n) => !covered.has(n));

    const inventory: Inventory = { entities: entities.map((e) => e.name), agencies, totals, uncoveredTables };
    mkdirSync(outDir, { recursive: true });
    await writeFile(join(outDir, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
    return inventory;
  } finally {
    await client.close(); // nothing to commit: the snapshot ends here
  }
}

/** sha256 of every file under `outDir`, keyed by relative path (repeatability checks). */
export async function hashOutput(outDir: string): Promise<Record<string, string>> {
  const res: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) await walk(p);
      else
        res[relative(outDir, p).split(sep).join('/')] = createHash('sha256')
          .update(await readFile(p))
          .digest('hex');
    }
  };
  if (existsSync(outDir)) await walk(outDir);
  return res;
}
