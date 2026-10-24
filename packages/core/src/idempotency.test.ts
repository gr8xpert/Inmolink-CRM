import type { Tx } from '@inmolink/db';
import { describe, expect, it, vi } from 'vitest';
import {
  assertSameRequest,
  IDEMPOTENCY_WINDOW_MS,
  idempotencyHashOf,
  idempotencyOf,
  idempotencyWindowStart,
  keyReusedOn,
  replayOf,
} from './idempotency';

const tx = { execute: vi.fn(async () => undefined) } as unknown as Tx;
const code = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'none';
  } catch (err) {
    return (err as { code?: string }).code ?? 'other';
  }
};

describe('Idempotency-Key helper', () => {
  it('[S11-F1] no key → no hashes, no lookup', async () => {
    expect(idempotencyOf('crm.task', 'u1', undefined, { a: 1 })).toBeNull();
    expect(idempotencyHashOf('crm.contact', 'u1', undefined)).toBeNull();
    const lookup = vi.fn();
    expect(await replayOf(tx, null, lookup)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('[S11-F1] the key is scoped to operation and caller; the body fingerprint follows the body', () => {
    const a = idempotencyOf('crm.task', 'u1', 'k', { a: 1 });
    expect(a).toEqual(idempotencyOf('crm.task', 'u1', 'k', { a: 1 }));
    expect(a?.hash).not.toBe(idempotencyOf('crm.lead', 'u1', 'k', { a: 1 })?.hash);
    expect(a?.hash).not.toBe(idempotencyOf('crm.task', 'u2', 'k', { a: 1 })?.hash);
    expect(a?.hash).toBe(idempotencyOf('crm.task', 'u1', 'k', { a: 2 })?.hash);
    expect(a?.requestHash).not.toBe(idempotencyOf('crm.task', 'u1', 'k', { a: 2 })?.requestHash);
  });

  it('[S11-F1] replay returns the stored row for the same body, looked up from the 24 h window start', async () => {
    const key = idempotencyOf('crm.task', 'u1', 'k', { a: 1 });
    const now = new Date('2026-01-02T00:00:00Z');
    const lookup = vi.fn(async (_since: Date, _key: unknown) => ({ id: 't1', requestHash: key?.requestHash ?? null }));
    expect(await replayOf(tx, key, lookup, { now })).toEqual({ id: 't1', requestHash: key?.requestHash });
    expect(lookup).toHaveBeenCalledWith(new Date(now.getTime() - IDEMPOTENCY_WINDOW_MS), key);
    expect(idempotencyWindowStart(now).toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('[S11-F1] another body with the key, or a row without a stored body, is IDEMPOTENCY_KEY_REUSED', async () => {
    const key = idempotencyOf('crm.task', 'u1', 'k', { a: 1 });
    const other = idempotencyOf('crm.task', 'u1', 'k', { a: 2 });
    expect(await code(replayOf(tx, key, async () => ({ requestHash: other?.requestHash ?? null })))).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect(await code(replayOf(tx, key, async () => ({ requestHash: null })))).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await code(() => assertSameRequest({ requestHash: null }, key as NonNullable<typeof key>))).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('[S11-F1] no prior row in the window → a new request; `lock` takes the advisory lock first', async () => {
    const key = idempotencyOf('crm.task', 'u1', 'k', {});
    const execute = vi.fn(async () => undefined);
    expect(await replayOf({ execute } as unknown as Tx, key, async () => null, { lock: true })).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    await replayOf({ execute } as unknown as Tx, key, async () => null);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('[S11-F1] a unique-index hit on the key (reuse after 24 h) is IDEMPOTENCY_KEY_REUSED; anything else rethrows', async () => {
    const guard = keyReusedOn('tasks_idempotency_uq');
    const hit = { cause: { code: '23505', constraint: 'tasks_idempotency_uq' } };
    expect(await code(() => guard(hit))).toBe('IDEMPOTENCY_KEY_REUSED');
    const otherIndex = { cause: { code: '23505', constraint: 'x' } };
    expect(() => guard(otherIndex)).toThrow(otherIndex as unknown as Error);
  });
});
