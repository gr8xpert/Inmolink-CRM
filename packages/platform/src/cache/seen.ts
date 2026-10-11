import type { Redis } from 'ioredis';
import type { Logger } from '../logger';
import { whenReady } from './ready';

const SET_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Keeps the later of the stored and the new time (several processes mark the same id). */
const MARK = `
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if (not cur) or tonumber(cur) < tonumber(ARGV[2]) then redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]) end
return 1
`;
/** Read and clear in one step, so a mark made meanwhile lands in the next drain. */
const DRAIN = `
local v = redis.call('HGETALL', KEYS[1])
redis.call('DEL', KEYS[1])
return v
`;

/**
 * "Last seen" times on redis-cache (S1-05: API key `last_used_at`). Request paths `mark` an id — one
 * small Redis call, never a database write — and a worker `drain`s the set into the database in one
 * batched statement. Best effort: a mark lost to eviction or an outage only makes "last seen" older.
 */
export class SeenTimes {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly logger: Logger,
  ) {}

  private key(set: string): string {
    if (!SET_RE.test(set)) throw new TypeError('seen: invalid set name');
    return `${this.prefix}:seen:${set}`;
  }

  /** Records that `id` was seen at `at`. Never throws: errors are logged. */
  async mark(set: string, id: string, at: Date): Promise<void> {
    if (!ID_RE.test(id)) throw new TypeError('seen: invalid id');
    const key = this.key(set);
    try {
      await whenReady(this.redis);
      await this.redis.eval(MARK, 1, key, id, String(at.getTime()));
    } catch (err) {
      this.logger.warn({ err, set }, 'seen: mark failed');
    }
  }

  /** Every id marked since the last drain, with its latest time; the set is emptied. */
  async drain(set: string): Promise<Map<string, Date>> {
    const key = this.key(set);
    await whenReady(this.redis);
    const flat = (await this.redis.eval(DRAIN, 1, key)) as string[];
    const out = new Map<string, Date>();
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const ms = Number(flat[i + 1]);
      const id = flat[i];
      if (id && Number.isFinite(ms)) out.set(id, new Date(ms));
    }
    return out;
  }
}
