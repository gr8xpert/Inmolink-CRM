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
import pg from 'pg';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/i;

/** One legacy entity: where it lives and how it belongs to an agency. Column names are config (the real schema is H1). */
export interface EntitySpec {
  /** Staging file name and inventory key. */
  name: string;
  table: string;
  schema?: string;
  idColumn: string;
  /** Own agency column; mutually exclusive with `viaParent`. The agencies entity itself uses `isAgency`. */
  agencyColumn?: string;
  /** Child rows without an agency column: joined to a parent entity's table. */
  viaParent?: { entity: string; fkColumn: string };
  /** The entity whose rows are the agencies (batching key). */
  isAgency?: boolean;
  /**
   * S14-04: the row's last-change timestamp for the delta sync (default `updated_at`). A table without it is read whole
   * on every delta (the full-compare fallback).
   */
  updatedColumn?: string;
}

/** Best-known legacy shape (PLAN §14, M22). Override per dump with `--map <file.json>` once H1 delivers the schema. */
export const DEFAULT_ENTITIES: EntitySpec[] = [
  { name: 'agencies', table: 'agencies', idColumn: 'id', isAgency: true },
  { name: 'users', table: 'users', idColumn: 'id', agencyColumn: 'agency_id' },
  { name: 'contacts', table: 'contacts', idColumn: 'id', agencyColumn: 'agency_id' },
  { name: 'leads', table: 'leads', idColumn: 'id', agencyColumn: 'agency_id' },
  { name: 'properties', table: 'properties', idColumn: 'id', agencyColumn: 'agency_id' },
  {
    name: 'property_images',
    table: 'property_images',
    idColumn: 'id',
    viaParent: { entity: 'properties', fkColumn: 'property_id' },
  },
  { name: 'developments', table: 'developments', idColumn: 'id', agencyColumn: 'agency_id' },
  // S4-04: the units of a new-build project (`legacy:load` loads both files).
  {
    name: 'development_units',
    table: 'development_units',
    idColumn: 'id',
    viaParent: { entity: 'developments', fkColumn: 'development_id' },
  },
];

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

export function assertIdent(value: string, what: string): string {
  if (!IDENT.test(value)) throw new TypeError(`invalid ${what} identifier: ${JSON.stringify(value)}`);
  return pg.escapeIdentifier(value);
}

/** The extract never writes into the repo (CLAUDE.md: legacy data stays outside it). */
export function assertOutsideRepo(outDir: string): string {
  const abs = resolve(outDir);
  const rel = relative(REPO_ROOT, abs);
  const outside = rel.startsWith('..') || /^[a-z]:/i.test(rel) || rel.startsWith(sep);
  if (!outside) throw new Error(`--out must be outside the repository (${abs})`);
  return abs;
}

/** Postgres connection that cannot write: session default read-only, so even a stray statement is refused (25006). */
export async function openReadOnly(url: string): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
    options: '-c default_transaction_read_only=on -c statement_timeout=600000',
    application_name: 'inmolink-legacy-extract',
  });
  await client.connect();
  return client;
}

/** Stable JSON: sorted keys, Dates as ISO, bigint/Buffer as strings, so equal data gives equal bytes. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v === 'bigint') return v.toString();
    if (Buffer.isBuffer(v)) return `base64:${v.toString('base64')}`;
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return v;
  });
}

export const qualified = (e: EntitySpec) =>
  `${e.schema ? `${assertIdent(e.schema, 'schema')}.` : ''}${assertIdent(e.table, 'table')}`;

export function validateSpecs(entities: EntitySpec[]): void {
  const names = new Set<string>();
  for (const e of entities) {
    if (names.has(e.name)) throw new Error(`duplicate entity ${e.name}`);
    names.add(e.name);
    if (!/^[a-z0-9_]+$/i.test(e.name)) throw new TypeError(`invalid entity name ${e.name}`);
    qualified(e);
    assertIdent(e.idColumn, 'column');
    if (e.agencyColumn) assertIdent(e.agencyColumn, 'column');
    if (e.viaParent) assertIdent(e.viaParent.fkColumn, 'column');
    if (e.updatedColumn) assertIdent(e.updatedColumn, 'column');
    if (!e.isAgency && !e.agencyColumn && !e.viaParent) throw new Error(`entity ${e.name} has no agency scope`);
  }
  if (entities.filter((e) => e.isAgency).length !== 1) throw new Error('exactly one entity must have isAgency');
  for (const e of entities) {
    if (e.viaParent && !names.has(e.viaParent.entity))
      throw new Error(`${e.name}: unknown parent ${e.viaParent.entity}`);
  }
}

/** FROM/WHERE for one entity within one agency (`$1` = legacy agency id). The agency-owning table is aliased `t`. */
export function scope(e: EntitySpec, byName: Map<string, EntitySpec>): { from: string; where: string } {
  const t = qualified(e);
  if (e.isAgency) return { from: `${t} t`, where: `t.${assertIdent(e.idColumn, 'column')}::text = $1` };
  if (e.agencyColumn) return { from: `${t} t`, where: `t.${assertIdent(e.agencyColumn, 'column')}::text = $1` };
  const via = e.viaParent as NonNullable<EntitySpec['viaParent']>;
  const parent = byName.get(via.entity) as EntitySpec;
  if (parent.viaParent) throw new Error(`${e.name}: parent ${parent.name} must own an agency column (one level only)`);
  return {
    from: `${t} c JOIN ${qualified(parent)} t ON t.${assertIdent(parent.idColumn, 'column')} = c.${assertIdent(via.fkColumn, 'column')}`,
    where: scope(parent, byName).where,
  };
}

async function extractEntity(
  client: pg.Client,
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
  let after: string | null = null;
  let written = 0;
  for (;;) {
    // Keyset on the text form of the id: stable for numeric and uuid keys alike; no OFFSET.
    const page: pg.QueryResult<Record<string, unknown>> = await client.query(
      `SELECT ${alias}.* FROM ${from} WHERE ${where}${after === null ? '' : ` AND ${idCol}::text > $2`} ORDER BY ${idCol}::text LIMIT ${limit}`,
      after === null ? [agencyId] : [agencyId, after],
    );
    if (page.rows.length === 0) break;
    for (const row of page.rows) {
      const line = `${stableJson(row)}\n`;
      hash.update(line);
      if (!out.write(line)) await once(out, 'drain');
      written++;
    }
    after = String((page.rows[page.rows.length - 1] as Record<string, unknown>)[e.idColumn]);
    if (page.rows.length < limit) break;
  }
  out.end();
  await once(out, 'finish');
  renameSync(tmp, file);
  return { legacyRows: Number(total.rows[0]?.n ?? 0), extractedRows: written, sha256: hash.digest('hex') };
}

/** Runs the extract. Resolves with the inventory (also written to `<out>/inventory.json`). */
export async function runExtract(opts: ExtractOptions): Promise<Inventory> {
  const entities = opts.entities ?? DEFAULT_ENTITIES;
  validateSpecs(entities);
  const byName = new Map(entities.map((e) => [e.name, e]));
  const outDir = assertOutsideRepo(opts.outDir);
  const batchSize = opts.batchSize ?? 1000;
  const agencySpec = entities.find((e) => e.isAgency) as EntitySpec;

  const client = await openReadOnly(opts.url);
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const ro = await client.query<{ v: string }>('SELECT current_setting($1) AS v', ['transaction_read_only']);
    if (ro.rows[0]?.v !== 'on') throw new Error('legacy connection is not read-only; refusing to continue');

    const idList = (
      await client.query<{ id: string }>(
        `SELECT ${assertIdent(agencySpec.idColumn, 'column')}::text AS id FROM ${qualified(agencySpec)} ORDER BY 1`,
      )
    ).rows.map((r) => r.id);
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
    const uncoveredTables = tables.rows.map((r) => `${r.s}.${r.t}`).filter((n) => !covered.has(n));

    await client.query('ROLLBACK'); // nothing to commit; the snapshot ends here
    const inventory: Inventory = { entities: entities.map((e) => e.name), agencies, totals, uncoveredTables };
    mkdirSync(outDir, { recursive: true });
    await writeFile(join(outDir, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
    return inventory;
  } finally {
    await client.end().catch(() => {});
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
