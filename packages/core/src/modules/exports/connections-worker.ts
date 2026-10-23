/**
 * exports — worker side of portal connections (S10-F1): what the feed generator and the push engine read of a
 * connection, as `app_system` (`withSystem`, a `tx` and no `ctx`). Not part of the module's `index.ts` (the dashboard
 * API's surface); used by `feed.ts` and `push/engine.ts`, which only the worker-only entry (`./worker`) exposes.
 */
import type { Tx } from '@inmolink/db';
import * as repo from './repo';
import { ruleOf, type SelectionRule, selectionBatch } from './selection';

/** A connection as the generator (worker) needs it: what to send to which portal, and the version it read it at. */
export interface WorkerConnection {
  id: string;
  agencyId: string;
  channelCode: string;
  name: string;
  enabled: boolean;
  /** Set: the feed token was revoked (nothing to serve). */
  revokedAt: Date | null;
  /** The connection's version when the pass loaded it (a change meanwhile queues its own run: `exports.connection.changed`). */
  version: number;
  rule: SelectionRule;
  /** S9-03: the served file when read (its run and content hash); null: none yet. */
  feed: { runId: string; sha256: string } | null;
}

function workerConnectionOf(row: repo.ConnectionRow): WorkerConnection {
  return {
    id: row.id,
    agencyId: row.agencyId,
    channelCode: row.channelCode,
    name: row.name,
    enabled: row.enabled,
    revokedAt: row.revokedAt,
    version: row.version,
    rule: ruleOf(row),
    feed: row.feedRunId && row.feedSha256 ? { runId: row.feedRunId, sha256: row.feedSha256 } : null,
  };
}

/**
 * Worker side (S9-03): the connections of one pass over an agency — these ids, or (`ids` null) every live one. One
 * statement.
 */
export async function workerConnections(
  tx: Tx,
  agencyId: string,
  ids: readonly string[] | null,
): Promise<WorkerConnection[]> {
  return (await repo.connectionsForPass(tx, agencyId, ids)).map(workerConnectionOf);
}

/**
 * Worker side: the next batch of a loaded connection's selection (same rules and limits as `selectListings`), with
 * no read of the connection itself — every batch of a run uses the one rule it was loaded with.
 */
export async function selectConnectionListings(
  tx: Tx,
  connection: Pick<WorkerConnection, 'rule'>,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<{ ids: string[]; nextCursor: string | null }> {
  const page = await selectionBatch(tx, connection.rule, opts.cursor ?? null, opts.limit);
  return { ids: page.ids, nextCursor: page.next };
}
