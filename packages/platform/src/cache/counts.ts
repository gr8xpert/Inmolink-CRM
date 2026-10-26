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

/** Read and clear in one step, so an increment made meanwhile lands in the next drain. */
const DRAIN = `
local v = redis.call('HGETALL', KEYS[1])
redis.call('DEL', KEYS[1])
return v
`;

/**
 * Shared counters on redis-cache (S15-02: legacy redirect hits counted by the public pages, written to the database by
 * a worker). Request processes `add` their buffered increments — one pipeline of `HINCRBY`s, never a database write —
 * and a worker `drain`s a set into the database in batched statements. Best effort (statistics): increments lost to
 * eviction or an outage are not replayed.
 */
export class Counters {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly logger: Logger,
  ) {}

  private key(set: string): string {
    if (!SET_RE.test(set)) throw new TypeError('counts: invalid set name');
    return `${this.prefix}:counts:${set}`;
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

  /** Every counter added since the last drain, with its total; the set is emptied. */
  async drain(set: string): Promise<Map<string, number>> {
    const key = this.key(set);
    await whenReady(this.redis);
    const flat = (await this.redis.eval(DRAIN, 1, key)) as string[];
    const out = new Map<string, number>();
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const n = Number(flat[i + 1]);
      const name = flat[i];
      if (name && Number.isInteger(n) && n > 0) out.set(name, n);
    }
    return out;
  }
}
