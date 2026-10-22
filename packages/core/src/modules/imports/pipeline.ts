import type { ConnectorContext, FeedConnector, FeedItemProblem } from './connectors';

/**
 * The run pipeline (S6-01): `fetch → parse (stream) → map → validate`, in batches. Pure orchestration: the caller
 * (`runner.ts`) commits each batch — the sink's write, the run's counters and its per-item errors — in one fenced
 * transaction. Nothing here touches the database, and no transaction is open while the feed is read.
 */

export interface ValidItem<Item = unknown> {
  position: number;
  ref: string;
  item: Item;
  /** S6-F4: the source hash to store once the item is stored. */
  sourceHash?: string;
}

export interface ItemError {
  position: number;
  itemRef: string | null;
  code: string;
  field: string | null;
  message: string | null;
}

export interface PendingBatch<Item = unknown> {
  /** Records parsed in this batch (valid + failed). */
  total: number;
  valid: ValidItem<Item>[];
  errors: ItemError[];
  /** S6-F4: refs of unchanged items reported as seen only: present in the feed, not written, not failed. */
  seen: string[];
  /** Bytes read from the feed so far (cumulative). */
  bytesRead: number;
}

export interface PipelineTotals {
  total: number;
  valid: number;
  failed: number;
  /** S6-F4: items seen only (unchanged; among `total`, not `valid` or `failed` of the pipeline). */
  seen: number;
  bytesRead: number;
}

const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const clip = (s: string | undefined, n: number) => (s === undefined || s === '' ? null : s.slice(0, n));

function toError(position: number, ref: string | undefined, p: FeedItemProblem): ItemError {
  return {
    position,
    itemRef: clip(ref, 200),
    code: CODE.test(p.code) ? p.code : 'INVALID_ITEM',
    field: clip(p.field, 120),
    message: clip(p.message, 500),
  };
}

export async function runFeedPipeline<Raw, Item>(opts: {
  connector: FeedConnector<Raw, Item>;
  ctx: ConnectorContext;
  batchSize: number;
  commit(batch: PendingBatch<Item>): Promise<void>;
  /** S6-F4: the source's counters when the run ends, whatever the outcome (for the run log). */
  onStats?(stats: Record<string, number>): void;
}): Promise<PipelineTotals> {
  const { connector, ctx, batchSize } = opts;
  const source = await connector.fetch(ctx);
  const totals: PipelineTotals = { total: 0, valid: 0, failed: 0, seen: 0, bytesRead: 0 };
  /**
   * Refs of the current batch: a second item with the same ref is an error, not an overwrite. Per batch only, so
   * memory stays bounded by the batch size; a ref an earlier batch had is the sink's check (S7-F2: the loader probes
   * the run's seen refs once per batch, `properties.importListingBatch`).
   */
  let seen = new Set<string>();
  let batch: PendingBatch<Item> = { total: 0, valid: [], errors: [], seen: [], bytesRead: 0 };

  const flush = async () => {
    if (batch.total === 0) return;
    batch.bytesRead = source.bytesRead();
    await opts.commit(batch);
    totals.total += batch.total;
    totals.valid += batch.valid.length;
    totals.failed += batch.errors.length; // one error per failed item (its first problem)
    totals.seen += batch.seen.length;
    totals.bytesRead = batch.bytesRead;
    batch = { total: 0, valid: [], errors: [], seen: [], bytesRead: 0 };
    seen = new Set<string>();
  };

  try {
    for await (const record of connector.parse(source, ctx)) {
      if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('run aborted');
      batch.total++;
      let mapped: ReturnType<typeof connector.map>;
      try {
        mapped = connector.map(record.raw, ctx);
      } catch {
        mapped = { ok: false, problems: [{ code: 'MAP_FAILED' }] };
      }
      if (!mapped.ok && mapped.seen && mapped.ref?.trim() && !seen.has(mapped.ref)) {
        batch.seen.push(mapped.ref);
        seen.add(mapped.ref);
      } else if (!mapped.ok) {
        const fallback = mapped.seen ? 'DUPLICATE_REF' : 'INVALID_ITEM';
        const problems = mapped.problems.length ? mapped.problems : [{ code: fallback }];
        batch.errors.push(toError(record.position, mapped.ref, problems[0] as FeedItemProblem));
        // S7-F2: the feed's first item with a ref wins even when it fails (the runner records its ref as seen, so a
        // later batch refuses the ref too).
        if (mapped.ref?.trim()) seen.add(mapped.ref);
      } else if (seen.has(mapped.ref)) {
        batch.errors.push(toError(record.position, mapped.ref, { code: 'DUPLICATE_REF', field: 'ref' }));
      } else {
        seen.add(mapped.ref);
        let problems: FeedItemProblem[];
        try {
          problems = connector.validate(mapped.item, ctx);
        } catch {
          problems = [{ code: 'VALIDATION_FAILED' }];
        }
        if (problems.length) batch.errors.push(toError(record.position, mapped.ref, problems[0] as FeedItemProblem));
        else
          batch.valid.push({
            position: record.position,
            ref: mapped.ref,
            item: mapped.item,
            ...(mapped.sourceHash ? { sourceHash: mapped.sourceHash } : {}),
          });
      }
      if (batch.total >= batchSize) await flush();
    }
    await flush();
    totals.bytesRead = source.bytesRead();
    return totals;
  } finally {
    const stats = source.stats?.();
    if (stats) opts.onStats?.(stats);
    // Stop the download when parsing ends early (error, abort); a no-op after a full read.
    const body = source.body as { destroy?: () => void };
    body.destroy?.();
  }
}
