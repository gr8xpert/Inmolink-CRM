import { createHash } from 'node:crypto';
import type { Tx } from '@inmolink/db';
import { safeEqual } from '@inmolink/platform/crypto';
import { AppError } from '@inmolink/platform/errors';
import { sql } from 'drizzle-orm';

/**
 * One `Idempotency-Key` helper for every create service (`.claude/rules/api.md`, S11-F1): a retry by the same caller
 * within 24 h with the same body answers the first result, another body with the key is `IDEMPOTENCY_KEY_REUSED`, and
 * so is a key older than the window (its unique index outlives it: the insert's 23505 maps to the same code).
 */

/** How long an `Idempotency-Key` replays the result it created. */
export const IDEMPOTENCY_WINDOW_MS = 24 * 3_600_000;

/** The stored pair: the key as scoped to its caller and operation, and the request body's fingerprint. */
export interface IdempotencyKey {
  hash: string;
  requestHash: string;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * The key's stored hashes, or `null` without a key. `scope` names the operation (`crm.task`), `callerId` the member:
 * one key never collides across operations or callers. `body` is what the key vouches for (JSON-serialized).
 */
export function idempotencyOf(
  scope: string,
  callerId: string | null,
  key: string | undefined,
  body: unknown,
): IdempotencyKey | null {
  if (!key) return null;
  return { hash: sha256(`${scope}:${callerId}:${key}`), requestHash: sha256(JSON.stringify(body)) };
}

/** Only the key's scoped hash, for creates that do not compare bodies (a contact replays by key alone). */
export function idempotencyHashOf(scope: string, callerId: string | null, key: string | undefined): string | null {
  return key ? sha256(`${scope}:${callerId}:${key}`) : null;
}

/** The start of the replay window. */
export const idempotencyWindowStart = (now: Date | number = Date.now()): Date =>
  new Date((typeof now === 'number' ? now : now.getTime()) - IDEMPOTENCY_WINDOW_MS);

/** Serializes work under one name for the rest of the transaction (concurrent retries wait their turn). */
export async function advisoryLock(tx: Tx, name: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${name}, 0))`);
}

/** Refuses a key that was used with another body. */
export function assertSameRequest(prior: { requestHash: string | null }, key: IdempotencyKey): void {
  if (!prior.requestHash || !safeEqual(prior.requestHash, key.requestHash))
    throw new AppError('IDEMPOTENCY_KEY_REUSED');
}

/**
 * The first result of this key within the window (`null`: a new request). `lookup` receives the window's start. With
 * `lock` (true, or the lock-name prefix), the key's advisory lock is taken first (tables whose unique index cannot span the key, e.g. partitions).
 * Another body with the key is `IDEMPOTENCY_KEY_REUSED`.
 */
export async function replayOf<P extends { requestHash: string | null }>(
  tx: Tx,
  key: IdempotencyKey | null,
  lookup: (since: Date, key: IdempotencyKey) => Promise<P | null>,
  opts: { lock?: boolean | string; now?: Date | number } = {},
): Promise<P | null> {
  if (!key) return null;
  if (opts.lock) await advisoryLock(tx, `${typeof opts.lock === 'string' ? opts.lock : 'idem'}:${key.hash}`);
  const prior = await lookup(idempotencyWindowStart(opts.now), key);
  if (!prior) return null;
  assertSameRequest(prior, key);
  return prior;
}

/** A unique-index violation (23505) of the named constraint: the key's index outlives the 24 h replay window. */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
  return cause?.code === '23505' && cause.constraint === constraint;
}

/** For `promise.catch(...)` on an insert: the key's unique index hit means `IDEMPOTENCY_KEY_REUSED`. */
export const keyReusedOn =
  (constraint: string) =>
  (err: unknown): never => {
    if (isUniqueViolation(err, constraint)) throw new AppError('IDEMPOTENCY_KEY_REUSED');
    throw err;
  };
