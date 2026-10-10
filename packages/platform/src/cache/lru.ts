import { type Clock, clock as processClock } from '../clock';

interface Entry<V> {
  value: V;
  expiresAt: number;
  tags: readonly string[];
}

/**
 * In-process LRU with a per-entry TTL, for hot config only (taxonomy, site configs, flags — PATTERNS §15).
 * Values are shared by reference between callers: treat them as immutable.
 */
export class LocalLru<V = unknown> {
  private readonly entries = new Map<string, Entry<V>>();

  constructor(
    private readonly maxEntries = 1_000,
    private readonly clock: Clock = processClock,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('maxEntries must be a positive integer');
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.clock.nowMs()) {
      this.entries.delete(key);
      return undefined;
    }
    // Map keeps insertion order: re-inserting marks the entry most recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number, tags: readonly string[] = []): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.clock.nowMs() + ttlMs, tags });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  deleteTagged(tag: string): void {
    for (const [key, entry] of this.entries) if (entry.tags.includes(tag)) this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
