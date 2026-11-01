import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Logger } from '../logger';
import { whenReady } from './ready';

const SET_RE = /^[a-z][a-z0-9._-]{0,63}$/;
/** A counter's name: printable, at most 4 KB (S15-02: a legacy URL's lookup key). */
const MAX_NAME_CHARS = 4_096;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse them
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Counters per `add` call (one pipeline). */
const MAX_PER_ADD = 5_000;

/**
 * Bookkeeping fields of a taken set. Counter names never hold a control character (`add` refuses them), so these
 * cannot collide with a counter.
 */
const LEASE_FIELD = '\u0001lease';
const UNTIL_FIELD = '\u0001until';
const ATTEMPTS_FIELD = '\u0001attempts';

/**
 * S16-F3, step one of a drain. A taken set held by another drain's live lease: false (busy). Else the set moves to its
 * `:taken` key (RENAME: atomic, so an increment made meanwhile lands in a new set for the next drain) — unless a taken
 * set is still there (a drain that never settled: its write failed, it was aborted, or its worker died), which is taken
 * again instead. Either way the caller's lease (token, expiry by the server's clock) is stamped in and the attempt
 * count raised. The counters leave Redis only in step two (`settle`, by the lease holder).
 * KEYS: set, taken · ARGV: token, lease field, until field, attempts field, lease ms.
 */
const TAKE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if redis.call('EXISTS', KEYS[2]) == 1 then
  local held = tonumber(redis.call('HGET', KEYS[2], ARGV[3]) or '0')
  if held > now then return false end
elseif redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('RENAME', KEYS[1], KEYS[2])
else
  return {}
end
redis.call('HSET', KEYS[2], ARGV[2], ARGV[1], ARGV[3], tostring(now + tonumber(ARGV[5])))
redis.call('HINCRBY', KEYS[2], ARGV[4], 1)
return redis.call('HGETALL', KEYS[2])
`;

/** Step two: the lease holder's counters were written — delete them (only while it still holds the lease). */
const SETTLE = `
if redis.call('HGET', KEYS[1], ARGV[2]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

/** The write failed before committing: give the lease up so the next drain retries at once (holder only). */
const RELEASE = `
if redis.call('HGET', KEYS[1], ARGV[2]) == ARGV[1] then
  redis.call('HDEL', KEYS[1], ARGV[3])
  return 1
end
return 0
`;

/** A `take`: the counters, the lease to `settle` / `release` them with, and how often this set has been taken. */
export interface TakenCounts {
  counts: Map<string, number>;
  /** Empty when nothing was taken (no counters). */
  lease: string;
  /** Takes of this set so far, this one included (1: a fresh set; more: retries of an unsettled one). */
  attempts: number;
}

/**
 * Shared counters on redis-cache (S15-02: legacy redirect hits counted by the public pages, written to the database by
 * a worker). Request processes `add` their buffered increments — one pipeline of `HINCRBY`s, never a database write —
 * and a worker drains a set into the database in batched statements (S16-F3: `take`, write, `settle`). Best effort
 * (statistics): increments lost to eviction or an outage are not replayed.
 */
export class Counters {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly logger: Logger,
  ) {}

  /** S16-F3: the set name is the hash tag — a set and its taken key share a Cluster slot (one Lua script). */
  private key(set: string): string {
    if (!SET_RE.test(set)) throw new TypeError('counts: invalid set name');
    return `${this.prefix}:counts:{${set}}`;
  }

  /** Adds `counts` (name → positive increment) to the set. Never throws: errors are logged. Bad names are skipped. */
  async add(set: string, counts: ReadonlyMap<string, number>): Promise<void> {
    const key = this.key(set);
    const entries = [...counts].filter(
      ([name, n]) =>
        name.length > 0 && name.length <= MAX_NAME_CHARS && !CONTROL.test(name) && Number.isInteger(n) && n > 0,
    );
    if (entries.length === 0) return;
    try {
      await whenReady(this.redis);
      for (let i = 0; i < entries.length; i += MAX_PER_ADD) {
        const pipeline = this.redis.pipeline();
        for (const [name, n] of entries.slice(i, i + MAX_PER_ADD)) pipeline.hincrby(key, name, n);
        await pipeline.exec();
      }
    } catch (err) {
      this.logger.warn({ err, set }, 'counts: add failed');
    }
  }

  /**
   * S16-F3, a two-step drain under a lease. The counters to write — those of a previous `take` not yet settled (a
   * failed or aborted flush, retried from Redis), else every counter added since the last take — stay in Redis until
   * the lease holder's `settle(set, lease)` after its write committed. Null: another drain holds the taken set's lease
   * (`leaseMs`, by the Redis server's clock) — overlapping drains (a timed-out job still running beside its retry, a
   * stalled job's re-run) never write the same counters twice, and a late `settle` never deletes a newer holder's set.
   * `leaseMs` must outlast the holder's own deadline (its job timeout): after that it is aborted before committing.
   * Still at least once: a write that committed but whose settle never ran is written again once the lease expires.
   */
  async take(set: string, opts: { leaseMs: number }): Promise<TakenCounts | null> {
    if (!Number.isInteger(opts.leaseMs) || opts.leaseMs < 1_000) throw new RangeError('counts: leaseMs >= 1000');
    const key = this.key(set);
    await whenReady(this.redis);
    const lease = randomUUID();
    const flat = (await this.redis.eval(
      TAKE,
      2,
      key,
      `${key}:taken`,
      lease,
      LEASE_FIELD,
      UNTIL_FIELD,
      ATTEMPTS_FIELD,
      String(opts.leaseMs),
    )) as string[] | null;
    if (flat === null) return null;
    const counts = new Map<string, number>();
    let attempts = 0;
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const name = flat[i] as string;
      const n = Number(flat[i + 1]);
      if (name === ATTEMPTS_FIELD) attempts = n;
      else if (name && !CONTROL.test(name) && Number.isInteger(n) && n > 0) counts.set(name, n);
    }
    return { counts, lease: flat.length > 0 ? lease : '', attempts };
  }

  /** S16-F3, step two: the lease holder's counters were written — they leave Redis. False: the lease was lost. */
  async settle(set: string, lease: string): Promise<boolean> {
    if (!lease) return false;
    const key = this.key(set);
    await whenReady(this.redis);
    return (await this.redis.eval(SETTLE, 1, `${key}:taken`, lease, LEASE_FIELD)) === 1;
  }

  /** S16-F3: the write failed before committing — the counters stay taken, the next `take` retries them at once. */
  async release(set: string, lease: string): Promise<boolean> {
    if (!lease) return false;
    const key = this.key(set);
    await whenReady(this.redis);
    return (await this.redis.eval(RELEASE, 1, `${key}:taken`, lease, LEASE_FIELD, UNTIL_FIELD)) === 1;
  }
}
