import { type SQL, sql } from 'drizzle-orm';
import { newId } from '../ids';
import type { SqlExecutor } from '../sql';
import { currentTraceparent } from '../telemetry/context';
import { PLATFORM_AGENCY_ID } from '../tenancy';
import type { OutboxMessage } from './events';

export type { SqlExecutor } from '../sql';
/** `agency_id` of platform-wide events (no tenant); defined in `@inmolink/platform/tenancy`. */
export { PLATFORM_AGENCY_ID };

export interface EmitOptions {
  /** Defaults to `payload.agencyId`, then the transaction's tenant (`app.agency_id`), then `PLATFORM_AGENCY_ID`. */
  agencyId?: string;
}

/** Payloads carry IDs and small parameters (workers.md); data is loaded by the consumer. */
export const MAX_EVENT_PAYLOAD_BYTES = 10_240;

/**
 * Rows per insert statement. Each statement binds one array per column (S8-F3), so the count is not bound by
 * Postgres's parameter limit, but by the statement's size: at most ~10k × 10 KB of payload, typically ~2 MB.
 */
export const EMIT_CHUNK_ROWS = 10_000;

/** Payload bytes per insert statement: 10k events of 10 KB would otherwise be one ~100 MB statement. */
export const EMIT_CHUNK_BYTES = 8 * 1024 * 1024;

function agencyOf(message: OutboxMessage, options: EmitOptions): string | null {
  const p = message.payload as { agencyId?: unknown } | null;
  const fromPayload = p && typeof p === 'object' && typeof p.agencyId === 'string' ? p.agencyId : null;
  // RLS checks the row's agency_id only; a payload naming another agency would mislead consumers.
  if (options.agencyId && fromPayload && options.agencyId !== fromPayload) {
    throw new TypeError(`emit ${message.type}: options.agencyId and payload.agencyId differ`);
  }
  return options.agencyId ?? fromPayload;
}

/**
 * Writes events in the caller's transaction (PLAN §5.3 #6): they exist if and only if the change
 * commits. Never call search, email or HTTP here — subscribers do that later, in the worker.
 * No NOTIFY (ADR 0014): it would serialise the commits of every emitting transaction; the dispatcher polls.
 */
export async function emit(
  tx: SqlExecutor,
  message: OutboxMessage | readonly OutboxMessage[],
  options: EmitOptions = {},
): Promise<void> {
  const messages = Array.isArray(message) ? message : [message as OutboxMessage];
  if (messages.length === 0) return;
  const json: string[] = [];
  const sizes: number[] = [];
  for (const m of messages) {
    const text = JSON.stringify(m.payload);
    const bytes = Buffer.byteLength(text);
    json.push(text);
    sizes.push(bytes);
    if (bytes > MAX_EVENT_PAYLOAD_BYTES) {
      throw new TypeError(`emit ${m.type}: payload is ${bytes} bytes (max ${MAX_EVENT_PAYLOAD_BYTES}); carry IDs only`);
    }
  }
  const traceParent = currentTraceparent();
  // One bind parameter per column (`unnest` of arrays, S8-F3): a statement per 10,000 events, not per 1,000 rows of
  // six parameters each — a feed batch's events (thousands) are one statement.
  const array = (values: readonly unknown[], type: string) => sql`${sql.param(values)}::${sql.raw(type)}[]`;
  let i = 0;
  while (i < messages.length) {
    let end = i;
    let bytes = 0;
    while (
      end < messages.length &&
      end - i < EMIT_CHUNK_ROWS &&
      (end === i || bytes + (sizes[end] ?? 0) <= EMIT_CHUNK_BYTES)
    ) {
      bytes += sizes[end] ?? 0;
      end++;
    }
    const chunk = messages.slice(i, end);
    const chunkJson = json.slice(i, end);
    i = end;
    await tx.execute(
      sql`insert into outbox_events (id, agency_id, type, version, payload, trace_parent)
          select v.id, coalesce(v.agency_id, nullif(current_setting('app.agency_id', true), '')::uuid, ${PLATFORM_AGENCY_ID}::uuid),
                 v.type, v.version, v.payload, ${traceParent}::text
            from unnest(${array(
              chunk.map(() => newId()),
              'uuid',
            )}, ${array(
              chunk.map((m) => agencyOf(m, options)),
              'uuid',
            )}, ${array(
              chunk.map((m) => m.type),
              'text',
            )}, ${array(
              chunk.map((m) => m.version),
              'integer',
            )}, ${array(chunkJson, 'jsonb')}) as v(id, agency_id, type, version, payload)`,
    );
  }
}

/**
 * An event as an `insert … select … from <source>` statement (S7-05), for a writable CTE: the caller's row and its
 * event are written by **one** statement, and the event exists only when `source` yields a row (e.g.
 * `with ins as (insert … on conflict do nothing returning id) <this>`). `source` names a CTE of exactly one row or
 * none; `agencyId` is explicit (RLS checks it like `emit`'s).
 */
export function emitFrom(message: OutboxMessage, source: SQL, options: { agencyId: string }): SQL {
  const bytes = Buffer.byteLength(JSON.stringify(message.payload));
  if (bytes > MAX_EVENT_PAYLOAD_BYTES) {
    throw new TypeError(
      `emitFrom ${message.type}: payload is ${bytes} bytes (max ${MAX_EVENT_PAYLOAD_BYTES}); carry IDs only`,
    );
  }
  agencyOf(message, options);
  return sql`insert into outbox_events (id, agency_id, type, version, payload, trace_parent)
    select ${newId()}, ${options.agencyId}::uuid, ${message.type}, ${message.version},
           ${JSON.stringify(message.payload)}::jsonb, ${currentTraceparent()} from ${source}`;
}
