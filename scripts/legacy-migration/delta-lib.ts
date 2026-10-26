// Legacy delta reader (S14-04, PLAN §14 Path A step 5): one read-only snapshot of a legacy agency for the hourly delta
// (`syncLegacyDelta`). Same safety as the extract (S14-01, `extract-lib.ts`): the session is read-only, the work runs in
// one `REPEATABLE READ READ ONLY` transaction, every statement is a SELECT built from validated identifiers, keyset
// pages (no OFFSET). Rows are normalized as the extract writes them (`stableJson`), so the load sees the same shapes.
//
// Change detection (H1 — the legacy schema is not delivered yet): a table with the entity's `updatedColumn` (default
// `updated_at`) is read for rows changed after the watermark; a table without one is read whole (the full-compare
// fallback: the load writes nothing for an unchanged row). `modes` tells which applies per entity.
import {
  LEGACY_STAGING,
  type LegacyStagingEntity,
  type OpenedLegacyDeltaSource,
  type StagedSource,
} from '@inmolink/core/modules/migration';
import type pg from 'pg';
import {
  assertIdent,
  DEFAULT_ENTITIES,
  type EntitySpec,
  openReadOnly,
  scope,
  stableJson,
  validateSpecs,
} from './extract-lib';

const AGENCY_ID = /^[A-Za-z0-9_.-]{1,100}$/;

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
  /** Rows per keyset page. */
  pageSize?: number;
}

const normalize = (row: Record<string, unknown>): unknown => JSON.parse(stableJson(row));

/** Opens one legacy agency's snapshot. Close it (`close()`) when the delta is done. */
export async function openLegacyDeltaReader(opts: OpenDeltaOptions): Promise<LegacyDeltaReader> {
  if (!AGENCY_ID.test(opts.legacyAgencyId)) {
    throw new TypeError(`unsafe legacy agency id ${JSON.stringify(opts.legacyAgencyId)}`);
  }
  const entities = opts.entities ?? DEFAULT_ENTITIES;
  validateSpecs(entities);
  const byName = new Map(entities.map((e) => [e.name, e]));
  const pageSize = Math.max(1, Math.trunc(opts.pageSize ?? 1000));
  const client = await openReadOnly(opts.url);
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const ro = await client.query<{ v: string }>('SELECT current_setting($1) AS v', ['transaction_read_only']);
    if (ro.rows[0]?.v !== 'on') throw new Error('legacy connection is not read-only; refusing to continue');
    // now() is the transaction's start: every row committed before it is in this snapshot.
    const clock = await client.query<{ now: Date }>('SELECT now() AS now');
    const snapshotAt = clock.rows[0]?.now as Date;

    const modes: Partial<Record<LegacyStagingEntity, DeltaMode>> = {};
    for (const key of Object.keys(LEGACY_STAGING) as LegacyStagingEntity[]) {
      const spec = byName.get(LEGACY_STAGING[key]);
      if (!spec) continue;
      modes[key] = (await hasColumn(client, spec, spec.updatedColumn ?? 'updated_at')) ? 'timestamp' : 'full';
    }

    /** Keyset pages of one entity of the agency: `select` over the scoped rows, optionally changed after `since`. */
    async function* pages(
      spec: EntitySpec,
      select: string,
      since: Date | null,
    ): AsyncIterable<Record<string, unknown>[]> {
      const { from, where } = scope(spec, byName);
      const alias = spec.viaParent ? 'c' : 't';
      const idCol = `${alias}.${assertIdent(spec.idColumn, 'column')}`;
      const params: unknown[] = [opts.legacyAgencyId];
      let filter = '';
      if (since) {
        params.push(since);
        filter = ` AND ${alias}.${assertIdent(spec.updatedColumn ?? 'updated_at', 'column')} > $${params.length}`;
      }
      let after: string | null = null;
      for (;;) {
        const args = after === null ? params : [...params, after];
        const page: pg.QueryResult<Record<string, unknown>> = await client.query(
          `SELECT ${select} FROM ${from} WHERE ${where}${filter}${after === null ? '' : ` AND ${idCol}::text > $${args.length}`} ORDER BY ${idCol}::text LIMIT ${pageSize}`,
          args,
        );
        if (page.rows.length === 0) return;
        yield page.rows;
        if (page.rows.length < pageSize) return;
        after = String((page.rows[page.rows.length - 1] as Record<string, unknown>).__key);
      }
    }

    return {
      snapshotAt,
      modes,
      changed(entity, since): StagedSource | undefined {
        const spec = byName.get(LEGACY_STAGING[entity]);
        if (!spec) return undefined;
        const alias = spec.viaParent ? 'c' : 't';
        const key = `${alias}.${assertIdent(spec.idColumn, 'column')}::text AS __key`;
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
        const key = `${alias}.${assertIdent(spec.idColumn, 'column')}::text AS __key`;
        for await (const rows of pages(spec, key, null)) yield rows.map((r) => String(r.__key));
      },
      async close() {
        await client.query('ROLLBACK').catch(() => {});
        await client.end().catch(() => {});
      },
    };
  } catch (err) {
    await client.end().catch(() => {});
    throw err;
  }
}

async function hasColumn(client: pg.Client, spec: EntitySpec, column: string): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    [spec.schema ?? 'public', spec.table, column],
  );
  return (res.rowCount ?? 0) > 0;
}
