/**
 * Legacy delta reader (S14-04 → S15-F4, PLAN §14 Path A step 5): one read-only snapshot of a legacy agency for the
 * hourly delta (`syncLegacyDelta`), on the `platform/legacy-db` adapter (read-only session and transaction, statement
 * timeout, connection limit, server-side cursor). Every statement is a SELECT built from validated identifiers; rows
 * stream in cursor batches (no OFFSET, no whole-table result). Rows are normalized as the extract writes them
 * (`stableJson`), so the load sees the same shapes.
 *
 * Change detection (H1 — the legacy schema is not delivered yet): a table with the entity's `updatedColumn` (default
 * `updated_at`) is read for rows changed after the watermark; a table without one is read whole (the full-compare
 * fallback: the load writes nothing for an unchanged row). `modes` tells which applies per entity.
 */
import {
  type LegacyDbConfig,
  type LegacySnapshot,
  legacyIdent,
  openLegacySnapshot,
  stableJson,
} from '@inmolink/platform/legacy-db';
import { type LegacyDeltaSourceFactory, type OpenedLegacyDeltaSource, registerLegacyDeltaSource } from './delta';
import { LEGACY_STAGING, type LegacyStagingEntity, type StagedSource } from './legacy-agency';

const IDENT_AGENCY = /^[A-Za-z0-9_.-]{1,100}$/;

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

export const assertIdent = legacyIdent;

export const qualified = (e: EntitySpec) =>
  `${e.schema ? `${legacyIdent(e.schema, 'schema')}.` : ''}${legacyIdent(e.table, 'table')}`;

export function validateSpecs(entities: EntitySpec[]): void {
  const names = new Set<string>();
  for (const e of entities) {
    if (names.has(e.name)) throw new Error(`duplicate entity ${e.name}`);
    names.add(e.name);
    if (!/^[a-z0-9_]+$/i.test(e.name)) throw new TypeError(`invalid entity name ${e.name}`);
    qualified(e);
    legacyIdent(e.idColumn, 'column');
    if (e.agencyColumn) legacyIdent(e.agencyColumn, 'column');
    if (e.viaParent) legacyIdent(e.viaParent.fkColumn, 'column');
    if (e.updatedColumn) legacyIdent(e.updatedColumn, 'column');
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
  if (e.isAgency) return { from: `${t} t`, where: `t.${legacyIdent(e.idColumn, 'column')}::text = $1` };
  if (e.agencyColumn) return { from: `${t} t`, where: `t.${legacyIdent(e.agencyColumn, 'column')}::text = $1` };
  const via = e.viaParent as NonNullable<EntitySpec['viaParent']>;
  const parent = byName.get(via.entity) as EntitySpec;
  if (parent.viaParent) throw new Error(`${e.name}: parent ${parent.name} must own an agency column (one level only)`);
  return {
    from: `${t} c JOIN ${qualified(parent)} t ON t.${legacyIdent(parent.idColumn, 'column')} = c.${legacyIdent(via.fkColumn, 'column')}`,
    where: scope(parent, byName).where,
  };
}

export type DeltaMode = 'timestamp' | 'full';

export interface LegacyDeltaReader extends OpenedLegacyDeltaSource {
  /** How each staged entity's changes are found (by the legacy schema). */
  readonly modes: Partial<Record<LegacyStagingEntity, DeltaMode>>;
}

export interface OpenDeltaOptions {
  /** Connection string of the legacy database (read-only access). */
  url: string;
  legacyAgencyId: string;
  /** Entity specs (`--map`, as the extract's); default `DEFAULT_ENTITIES`. */
  entities?: EntitySpec[];
  /** Rows per cursor fetch. */
  pageSize?: number;
  /** Adapter limits (statement timeout, connection limit). */
  db?: Omit<LegacyDbConfig, 'url'>;
}

const normalize = (row: Record<string, unknown>): unknown => JSON.parse(stableJson(row));

/** Opens one legacy agency's snapshot. Close it (`close()`) when the delta is done. */
export async function openLegacyDeltaReader(opts: OpenDeltaOptions): Promise<LegacyDeltaReader> {
  if (!IDENT_AGENCY.test(opts.legacyAgencyId)) {
    throw new TypeError(`unsafe legacy agency id ${JSON.stringify(opts.legacyAgencyId)}`);
  }
  const entities = opts.entities ?? DEFAULT_ENTITIES;
  validateSpecs(entities);
  const byName = new Map(entities.map((e) => [e.name, e]));
  const pageSize = Math.max(1, Math.trunc(opts.pageSize ?? 1000));
  const snapshot: LegacySnapshot = await openLegacySnapshot({ ...opts.db, url: opts.url });
  try {
    const modes: Partial<Record<LegacyStagingEntity, DeltaMode>> = {};
    for (const key of Object.keys(LEGACY_STAGING) as LegacyStagingEntity[]) {
      const spec = byName.get(LEGACY_STAGING[key]);
      if (!spec) continue;
      modes[key] = (await hasColumn(snapshot, spec, spec.updatedColumn ?? 'updated_at')) ? 'timestamp' : 'full';
    }

    /** Cursor batches of one entity of the agency: `select` over the scoped rows, optionally changed after `since`. */
    function pages(spec: EntitySpec, select: string, since: Date | null): AsyncIterable<Record<string, unknown>[]> {
      const { from, where } = scope(spec, byName);
      const alias = spec.viaParent ? 'c' : 't';
      const idCol = `${alias}.${legacyIdent(spec.idColumn, 'column')}`;
      const params: unknown[] = [opts.legacyAgencyId];
      let filter = '';
      if (since) {
        params.push(since);
        filter = ` AND ${alias}.${legacyIdent(spec.updatedColumn ?? 'updated_at', 'column')} > $${params.length}`;
      }
      return snapshot.stream(
        `SELECT ${select} FROM ${from} WHERE ${where}${filter} ORDER BY ${idCol}::text`,
        params,
        pageSize,
      );
    }

    return {
      snapshotAt: snapshot.snapshotAt,
      modes,
      changed(entity, since): StagedSource | undefined {
        const spec = byName.get(LEGACY_STAGING[entity]);
        if (!spec) return undefined;
        const alias = spec.viaParent ? 'c' : 't';
        const key = `${alias}.${legacyIdent(spec.idColumn, 'column')}::text AS __key`;
        const from = modes[entity] === 'timestamp' ? since : null;
        return {
          async *batches(size: number) {
            const n = Math.max(1, Math.trunc(size));
            let batch: unknown[] = [];
            for await (const rows of pages(spec, `${alias}.*, ${key}`, from)) {
              for (const { __key: _k, ...row } of rows) {
                batch.push(normalize(row));
                if (batch.length >= n) {
                  yield batch;
                  batch = [];
                }
              }
            }
            if (batch.length > 0) yield batch;
          },
        };
      },
      async *listingIds() {
        const spec = byName.get(LEGACY_STAGING.listings);
        if (!spec) return;
        const alias = spec.viaParent ? 'c' : 't';
        const key = `${alias}.${legacyIdent(spec.idColumn, 'column')}::text AS __key`;
        for await (const rows of pages(spec, key, null)) yield rows.map((r) => String(r.__key));
      },
      close: () => snapshot.close(),
    };
  } catch (err) {
    await snapshot.close();
    throw err;
  }
}

async function hasColumn(snapshot: LegacySnapshot, spec: EntitySpec, column: string): Promise<boolean> {
  const rows = await snapshot.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    [spec.schema ?? 'public', spec.table, column],
  );
  return rows.length > 0;
}

export interface ConfigureLegacyDeltaInput {
  /** `LEGACY_DATABASE_URL`; absent: no reader is registered and the hourly job queues nothing. */
  url: string | undefined;
  entities?: EntitySpec[];
  db?: Omit<LegacyDbConfig, 'url'>;
}

/**
 * Registers the legacy reader the hourly delta job uses (worker start). Returns whether one is registered; the URL is
 * never logged.
 */
export function configureLegacyDelta(input: ConfigureLegacyDeltaInput): boolean {
  const { url } = input;
  if (!url) {
    registerLegacyDeltaSource(null);
    return false;
  }
  const factory: LegacyDeltaSourceFactory = (legacyAgencyId) =>
    openLegacyDeltaReader({
      url,
      legacyAgencyId,
      ...(input.entities ? { entities: input.entities } : {}),
      ...(input.db ? { db: input.db } : {}),
    });
  registerLegacyDeltaSource(factory);
  return true;
}
