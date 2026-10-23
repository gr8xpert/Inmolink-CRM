import type { Redis } from 'ioredis';

/**
 * Per-group fair share (workers.md, PLAN §5.3 #7) on open-source BullMQ, which has no groups:
 *
 * - **Interleaving** — a grouped job's BullMQ priority is its group's backlog depth at enqueue time
 *   (1 = next). A tenant flooding 1,000 jobs fills priorities 1…1,000, while another tenant's first
 *   job gets priority 1 and runs as soon as a worker slot frees. Ten busy groups interleave round-robin.
 * - **Caps** — `concurrencyPerGroup` is a lease set per group (Lua, atomic). A job that finds its
 *   group full goes back to delayed for a moment instead of occupying a worker slot.
 *
 * Backlog entries are removed when a job completes or dead-letters, and entries older than a day are
 * pruned, so a lost job cannot skew its group forever.
 */

export const MAX_PRIORITY = 2_097_151;
const BACKLOG_TTL_MS = 24 * 3_600_000;

const ACQUIRE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZSCORE', KEYS[1], ARGV[3]) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
  return 1
end
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[4]) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
  redis.call('PEXPIRE', KEYS[1], ARGV[5])
  return 1
end
return 0`;

// KEYS: n backlog keys, then n job keys (checked only where ARGV[4 + n + i] == '1').
// ARGV: prune-before, now, ttl, n, n members, n check flags. Returns n backlog depths.
const ENQUEUE_MANY = `
local n = tonumber(ARGV[4])
local pruned = {}
local depths = {}
for i = 1, n do
  local backlog = KEYS[i]
  if not pruned[backlog] then
    redis.call('ZREMRANGEBYSCORE', backlog, '-inf', ARGV[1])
    pruned[backlog] = true
  end
  if not (ARGV[4 + n + i] == '1' and redis.call('EXISTS', KEYS[n + i]) == 1) then
    redis.call('ZADD', backlog, 'NX', ARGV[2], ARGV[4 + i])
    redis.call('PEXPIRE', backlog, ARGV[3])
  end
  depths[i] = redis.call('ZCARD', backlog)
end
return depths`;

/** Group values are URI-encoded so they cannot break out of the key layout. */
const groupKey = (prefix: string, pool: string, group: string, kind: 'backlog' | 'active') =>
  `${prefix}:fair:${pool}:${encodeURIComponent(group)}:${kind}`;

/** A job definition's pool-wide cap (S6-08): its own key space, so no group value can collide with it. */
const capKey = (prefix: string, pool: string, name: string) => `${prefix}:cap:${pool}:${encodeURIComponent(name)}`;

export interface BacklogEntry {
  group: string;
  member: string;
  /** BullMQ job hash of a stable ID: when it exists, BullMQ will ignore the add, so nothing is recorded. */
  existingJobKey?: string;
}

type FairEnqueueMany = (numKeys: number, ...args: (string | number)[]) => Promise<number[]>;

/**
 * Defines the fair-share Lua commands (EVALSHA with transparent script loading) on `redis`. Idempotent.
 *
 * S10-F11: call it right after creating the client, before it sends anything. ioredis copies a client's custom commands
 * into an auto-pipeline when it opens one, so a command defined while a pipeline is open (a command earlier in the same
 * tick, or one queued behind an in-flight pipeline) is missing from it: `pipeline[functionName] is not a function`,
 * and an uncaught `results[i] is not iterable` when that pipeline replies.
 */
export function defineFairnessCommands(redis: Redis): void {
  if (!('inlFairEnqueueMany' in redis)) redis.defineCommand('inlFairEnqueueMany', { lua: ENQUEUE_MANY });
}

export class Fairness {
  /** `redis` must have its commands defined before first use (`defineFairnessCommands`) if it auto-pipelines. */
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {
    defineFairnessCommands(redis);
  }

  /**
   * Records the entries in their groups' backlogs and returns each BullMQ priority — one script call
   * for the whole batch. The keys of one call span groups, so redis-queue must stay a single node
   * (or every key share a hash tag via the prefix, e.g. `{inl}`).
   */
  async priorities(pool: string, entries: readonly BacklogEntry[], now = Date.now()): Promise<number[]> {
    if (entries.length === 0) return [];
    const backlogs = entries.map((e) => groupKey(this.prefix, pool, e.group, 'backlog'));
    const jobKeys = entries.map((e, i) => e.existingJobKey ?? (backlogs[i] as string));
    const run = (this.redis as unknown as Record<'inlFairEnqueueMany', FairEnqueueMany>).inlFairEnqueueMany;
    const depths = await run.call(
      this.redis,
      entries.length * 2,
      ...backlogs,
      ...jobKeys,
      now - BACKLOG_TTL_MS,
      now,
      BACKLOG_TTL_MS,
      entries.length,
      ...entries.map((e) => e.member),
      ...entries.map((e) => (e.existingJobKey ? '1' : '0')),
    );
    return depths.map((d) => Math.min(Math.max(Number(d), 1), MAX_PRIORITY));
  }

  async priorityFor(pool: string, entry: BacklogEntry): Promise<number> {
    const [priority] = await this.priorities(pool, [entry]);
    return priority as number;
  }

  /** Removes `member` from the group's backlog (job completed or dead-lettered). */
  async done(pool: string, group: string, member: string): Promise<void> {
    await this.redis.zrem(groupKey(this.prefix, pool, group, 'backlog'), member);
  }

  /** Takes one of the group's `cap` slots for `leaseMs`. Re-acquiring an owned slot renews it. */
  async acquire(
    pool: string,
    group: string,
    member: string,
    cap: number,
    leaseMs: number,
    now = Date.now(),
  ): Promise<boolean> {
    const ok = (await this.redis.eval(
      ACQUIRE,
      1,
      groupKey(this.prefix, pool, group, 'active'),
      now,
      now + leaseMs,
      member,
      cap,
      leaseMs * 2,
    )) as number;
    return ok === 1;
  }

  async release(pool: string, group: string, member: string): Promise<void> {
    await this.redis.zrem(groupKey(this.prefix, pool, group, 'active'), member);
  }

  /**
   * Takes one of `cap` slots of job definition (or cap group, S9 review) `name` across every process of the pool (S6-08,
   * `globalConcurrency`).
   * Same lease semantics as `acquire`: a crashed holder's slot frees itself when its lease lapses.
   */
  async acquireCap(
    pool: string,
    name: string,
    member: string,
    cap: number,
    leaseMs: number,
    now = Date.now(),
  ): Promise<boolean> {
    const ok = (await this.redis.eval(
      ACQUIRE,
      1,
      capKey(this.prefix, pool, name),
      now,
      now + leaseMs,
      member,
      cap,
      leaseMs * 2,
    )) as number;
    return ok === 1;
  }

  async releaseCap(pool: string, name: string, member: string): Promise<void> {
    await this.redis.zrem(capKey(this.prefix, pool, name), member);
  }
}
