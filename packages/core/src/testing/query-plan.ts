import type { Tx } from '@inmolink/db';
import type { AdminQuery } from '@inmolink/db/testing';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Query-plan helpers for retention and other maintenance statements (S13-F9): capture the SQL a repo function sends
 * (a recording `tx` that answers nothing), then EXPLAIN it on a `withAdminRollback` connection as an app role.
 */

/** The statements `fn` sends to its `tx` (each answered with no rows). */
export async function captureSql(fn: (tx: Tx) => Promise<unknown>): Promise<SQL[]> {
  const sent: SQL[] = [];
  const tx = {
    execute: async (q: SQL) => {
      sent.push(q);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Tx;
  await fn(tx);
  return sent;
}

export type PlanNode = Record<string, unknown>;

/** The plan's nodes (depth first) of `EXPLAIN (format json) <statement>` — not executed. */
export async function explainNodes(q: AdminQuery, statement: SQL): Promise<PlanNode[]> {
  const query = new PgDialect().sqlToQuery(statement);
  const out = await q(`explain (format json) ${query.sql}`, query.params);
  const plan = (Object.values(out[0] ?? {})[0] as { Plan: PlanNode }[])[0]?.Plan as PlanNode;
  const nodes: PlanNode[] = [];
  const walk = (n: PlanNode) => {
    nodes.push(n);
    for (const c of (n.Plans as PlanNode[] | undefined) ?? []) walk(c);
  };
  walk(plan);
  return nodes;
}

const INDEX_NODES = new Set(['Index Scan', 'Index Only Scan', 'Bitmap Index Scan']);

/** The index scan nodes that read `indexName`. */
export const indexScans = (nodes: readonly PlanNode[], indexName: string): PlanNode[] =>
  nodes.filter((n) => INDEX_NODES.has(String(n['Node Type'])) && n['Index Name'] === indexName);

/** Whether the plan reads `table` sequentially. */
export const seqScans = (nodes: readonly PlanNode[], table: string): boolean =>
  nodes.some((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === table);

/** One line per node, for a failing assertion's message. */
export const describePlan = (nodes: readonly PlanNode[]): string =>
  nodes.map((n) => `${n['Node Type']}${n['Index Name'] ? ` (${n['Index Name']})` : ''}`).join(' → ');
