import { RUNS } from './config';
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
  /** Bytes read from the feed so far (cumulative). */
  bytesRead: number;
}

export interface PipelineTotals {
  total: number;
  valid: number;
  failed: number;
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
}): Promise<PipelineTotals> {
  const { connector, ctx, batchSize } = opts;
  const source = await connector.fetch(ctx);
  const totals: PipelineTotals = { total: 0, valid: 0, failed: 0, bytesRead: 0 };
  /** Refs seen in this feed: a second item with the same ref is an error, not an overwrite. */
  const seen = new Set<string>();
  let batch: PendingBatch<Item> = { total: 0, valid: [], errors: [], bytesRead: 0 };

  const flush = async () => {
    if (batch.total === 0) return;
    batch.bytesRead = source.bytesRead();
    await opts.commit(batch);
    totals.total += batch.total;
    totals.valid += batch.valid.length;
    totals.failed += batch.errors.length; // one error per failed item (its first problem)
    totals.bytesRead = batch.bytesRead;
    batch = { total: 0, valid: [], errors: [], bytesRead: 0 };
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
      if (!mapped.ok) {
        const problems = mapped.problems.length ? mapped.problems : [{ code: 'INVALID_ITEM' }];
        batch.errors.push(toError(record.position, mapped.ref, problems[0] as FeedItemProblem));
      } else if (seen.has(mapped.ref)) {
        batch.errors.push(toError(record.position, mapped.ref, { code: 'DUPLICATE_REF', field: 'ref' }));
      } else {
        if (seen.size < RUNS.MAX_TRACKED_REFS) seen.add(mapped.ref); // bounded memory (worker RSS budget)
        let problems: FeedItemProblem[];
        try {
          problems = connector.validate(mapped.item, ctx);
        } catch {
          problems = [{ code: 'VALIDATION_FAILED' }];
        }
        if (problems.length) batch.errors.push(toError(record.position, mapped.ref, problems[0] as FeedItemProblem));
        else batch.valid.push({ position: record.position, ref: mapped.ref, item: mapped.item });
      }
      if (batch.total >= batchSize) await flush();
    }
    await flush();
    totals.bytesRead = source.bytesRead();
    return totals;
  } finally {
    // Stop the download when parsing ends early (error, abort); a no-op after a full read.
    const body = source.body as { destroy?: () => void };
    body.destroy?.();
  }
}
