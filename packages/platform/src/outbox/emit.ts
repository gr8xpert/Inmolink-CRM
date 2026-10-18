import { sql } from 'drizzle-orm';
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

/** Rows per insert statement (6 bind parameters each): far below Postgres's 65,535-parameter limit (S5-F3). */
export const EMIT_CHUNK_ROWS = 1_000;

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
  for (const m of messages) {
    const bytes = Buffer.byteLength(JSON.stringify(m.payload));
    if (bytes > MAX_EVENT_PAYLOAD_BYTES) {
      throw new TypeError(`emit ${m.type}: payload is ${bytes} bytes (max ${MAX_EVENT_PAYLOAD_BYTES}); carry IDs only`);
    }
  }
  const traceParent = currentTraceparent();
  const values = messages.map(
    (m) =>
      sql`(${newId()}, coalesce(${agencyOf(m, options)}::uuid, nullif(current_setting('app.agency_id', true), '')::uuid, ${PLATFORM_AGENCY_ID}::uuid),
           ${m.type}, ${m.version}, ${JSON.stringify(m.payload)}::jsonb, ${traceParent})`,
  );
  for (let i = 0; i < values.length; i += EMIT_CHUNK_ROWS) {
    await tx.execute(
      sql`insert into outbox_events (id, agency_id, type, version, payload, trace_parent) values ${sql.join(values.slice(i, i + EMIT_CHUNK_ROWS), sql`, `)}`,
    );
  }
}
