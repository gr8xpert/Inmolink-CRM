/**
 * In-process fixed-window counters (S8-F6): the fallback the website API keeps for when the limits Redis cannot answer.
 * The shared limiter fails open (a Redis outage must not take websites offline), so a process holds its own count of
 * what must stay bounded during an outage — form posts per key and browser (S8-F4), failed key checks per IP (S7-F9).
 *
 * - **Count always, enforce while failing open (S8-F9):** callers count every event, and refuse on a window only while
 *   the shared limiter fails open (`RateLimitResult.failedOpen`), so with Redis healthy a local window never changes an
 *   answer the shared limiter gives. A check with `enforce: false` is counted and never refuses.
 * - **Synchronous:** `reserve` checks and counts in one call, nothing interleaves; `release` gives a reservation back
 *   (once), and forgets a window the reservation started that is back at 0. `peek` / `hit` are the single-identity,
 *   allocation-free pair.
 * - **Pools tracked apart:** each pool has its own map, bound and window length, so identities an attacker can multiply
 *   (one per IP) never evict a window in another pool (API keys). One length per pool keeps insertion order = expiry
 *   order, so the sweep stops at the first live window.
 * - **Never refuses for lack of room:** only a window at its limit refuses. A full pool sweeps expired windows, then
 *   evicts a window under its limit — O(1): each pool keeps its under-limit windows in a linked list of their own
 *   (S8-F9), so one is found whenever one exists. Windows at their limit (boxed identities) are never evicted. When
 *   every window is boxed the new identity goes **untracked** — allowed (`peek` answers 0); callers bound untracked
 *   identities with a per-process cap (a one-identity pool, S8-F9), enforced only while the pool is `saturated` — it
 *   had to evict or leave an identity untracked within the last window length.
 * - **Per process:** with N processes an outage lets up to N × a limit through — bounded, not exact.
 */
import { clock } from '../clock';

export interface LocalPoolOptions {
  /** Most windows the pool tracks. */
  max: number;
  /** Window length of every identity in the pool. */
  windowMs: number;
}

export interface LocalWindowCheck<P extends string = string> {
  pool: P;
  identity: string;
  limit: number;
  /** False: counted, never refuses (S8-F9: the shared limiter answers). Default true. */
  enforce?: boolean;
}

export type LocalWindowReservation<P extends string = string> =
  | {
      allowed: true;
      release: () => void;
      /** Checks left untracked (their pool full of windows at their limit): counted nowhere locally. */
      untracked: number;
    }
  | { allowed: false; check: LocalWindowCheck<P>; retryAfterSeconds: number };

/**
 * One window. `prev` / `next` link the pool's under-limit windows (oldest first); `linked`: it is in that list, which
 * holds exactly the tracked windows with count < limit.
 */
interface Window {
  identity: string;
  expiresAtMs: number;
  count: number;
  limit: number;
  prev: Window | undefined;
  next: Window | undefined;
  linked: boolean;
}

class Pool {
  readonly map = new Map<string, Window>();
  /** Under-limit windows, oldest first (a window back under its limit after a release goes last): eviction candidates. */
  private head: Window | undefined;
  private tail: Window | undefined;
  /** Until when the pool counts as saturated: one window length after it last had to evict or leave one untracked. */
  saturatedUntilMs = Number.NEGATIVE_INFINITY;

  constructor(readonly options: LocalPoolOptions) {}

  live(identity: string, now: number): Window | undefined {
    const w = this.map.get(identity);
    if (w === undefined) return undefined;
    if (now < w.expiresAtMs) return w;
    this.drop(w);
    return undefined;
  }

  /**
   * Starts a window, or undefined (untracked) when the pool is full of windows at their limit. Never evicts a window
   * at its limit, nor `keep` (a window the same `reserve` already holds).
   */
  start(identity: string, limit: number, now: number, keep?: readonly (Window | undefined)[]): Window | undefined {
    if (this.map.size >= this.options.max) {
      this.sweep(now);
      if (this.map.size >= this.options.max) {
        this.saturatedUntilMs = now + this.options.windowMs;
        if (!this.evictOne(keep)) return undefined;
      }
    }
    const w: Window = {
      identity,
      expiresAtMs: now + this.options.windowMs,
      count: 0,
      limit,
      prev: undefined,
      next: undefined,
      linked: false,
    };
    this.map.set(identity, w);
    this.link(w);
    return w;
  }

  /**
   * Adds `delta` to a tracked window's count, takes the caller's current `limit` (a tier changed mid-window), and keeps
   * the window in (or out of) the under-limit list.
   */
  add(w: Window, delta: number, limit = w.limit): void {
    w.count = Math.max(0, w.count + delta);
    w.limit = limit;
    if (w.count >= w.limit) this.unlink(w);
    else if (this.map.get(w.identity) === w) this.link(w);
  }

  /** Forgets `w` if it is still this identity's window. */
  forget(identity: string, w: Window): void {
    if (this.map.get(identity) === w) this.drop(w);
  }

  clear(): void {
    this.map.clear();
    this.head = undefined;
    this.tail = undefined;
  }

  /** Drops expired windows from the oldest on (insertion order is expiry order: one length per pool). */
  private sweep(now: number): void {
    for (const w of this.map.values()) {
      if (now < w.expiresAtMs) break;
      this.drop(w);
    }
  }

  /** Evicts the oldest under-limit window not in `keep` (skips at most `keep.length` ≤ 30 windows). */
  private evictOne(keep?: readonly (Window | undefined)[]): boolean {
    for (let w = this.head; w !== undefined; w = w.next) {
      if (keep?.includes(w)) continue;
      this.drop(w);
      return true;
    }
    return false;
  }

  private drop(w: Window): void {
    this.map.delete(w.identity);
    this.unlink(w);
  }

  private link(w: Window): void {
    if (w.linked || w.count >= w.limit) return;
    w.linked = true;
    w.prev = this.tail;
    w.next = undefined;
    if (this.tail) this.tail.next = w;
    else this.head = w;
    this.tail = w;
  }

  private unlink(w: Window): void {
    if (!w.linked) return;
    w.linked = false;
    if (w.prev) w.prev.next = w.next;
    else this.head = w.next;
    if (w.next) w.next.prev = w.prev;
    else this.tail = w.prev;
    w.prev = undefined;
    w.next = undefined;
  }
}

function waitSeconds(expiresAtMs: number, now: number): number {
  return Math.max(1, Math.ceil((expiresAtMs - now) / 1_000));
}

export class LocalFixedWindows<P extends string> {
  private readonly pools: Record<P, Pool>;

  constructor(pools: Record<P, LocalPoolOptions>) {
    const built = {} as Record<P, Pool>;
    for (const name of Object.keys(pools) as P[]) built[name] = new Pool(pools[name]);
    this.pools = built;
  }

  /**
   * Takes one from every check, or none: refused (with the longest wait) when the tracked window of any enforced check
   * is at its limit. Checks naming the same pool and identity count once (the first one's limit and `enforce` apply).
   */
  reserve(checks: readonly LocalWindowCheck<P>[]): LocalWindowReservation<P> {
    const now = clock.nowMs();
    const n = checks.length;
    if (n > 30) throw new RangeError('LocalFixedWindows.reserve: at most 30 checks');
    const found: (Window | undefined)[] = new Array(n);
    let refused: LocalWindowCheck<P> | undefined;
    let refusedWait = 0;
    for (let i = 0; i < n; i++) {
      const check = checks[i] as LocalWindowCheck<P>;
      if (duplicateOf(checks, i) >= 0) continue;
      const w = this.pools[check.pool].live(check.identity, now);
      found[i] = w;
      if (w && check.enforce !== false && w.count >= check.limit) {
        const wait = waitSeconds(w.expiresAtMs, now);
        if (wait > refusedWait) {
          refused = check;
          refusedWait = wait;
        }
      }
    }
    if (refused) return { allowed: false, check: refused, retryAfterSeconds: refusedWait };
    let created = 0; // bit i: this reservation started check i's window
    let untracked = 0;
    for (let i = 0; i < n; i++) {
      const check = checks[i] as LocalWindowCheck<P>;
      if (duplicateOf(checks, i) >= 0) continue;
      const pool = this.pools[check.pool];
      let w = found[i];
      if (!w) {
        w = pool.start(check.identity, check.limit, now, found);
        if (w) created |= 1 << i;
      }
      if (w) pool.add(w, 1, check.limit);
      else untracked++;
      found[i] = w;
    }
    let released = false;
    return {
      allowed: true,
      untracked,
      release: () => {
        if (released) return;
        released = true;
        for (let i = 0; i < n; i++) {
          const w = found[i];
          if (!w) continue;
          const check = checks[i] as LocalWindowCheck<P>;
          const pool = this.pools[check.pool];
          pool.add(w, -1);
          if (w.count === 0 && created & (1 << i)) pool.forget(check.identity, w);
        }
      },
    };
  }

  /** Seconds until the identity may go on, or 0 — counting nothing. An untracked identity is never refused. */
  peek(pool: P, identity: string, limit: number): number {
    const now = clock.nowMs();
    const w = this.pools[pool].live(identity, now);
    return w && w.count >= limit ? waitSeconds(w.expiresAtMs, now) : 0;
  }

  /** Counts one against the identity, past its limit too; false when it went untracked (a pool full of boxed windows). */
  hit(pool: P, identity: string, limit: number): boolean {
    const now = clock.nowMs();
    const p = this.pools[pool];
    const w = p.live(identity, now) ?? p.start(identity, limit, now);
    if (!w) return false;
    p.add(w, 1, limit);
    return true;
  }

  /**
   * The pool had to evict a window, or leave an identity untracked, within the last window length (S8-F9): identities
   * are going untracked or are being rotated out, so per-process caps over untracked identities apply.
   */
  saturated(pool: P): boolean {
    return clock.nowMs() < this.pools[pool].saturatedUntilMs;
  }

  /** Windows tracked in a pool (tests, metrics). */
  size(pool: P): number {
    return this.pools[pool].map.size;
  }

  /** A pool's window length (callers rebuild when their configured length changes). */
  windowMs(pool: P): number {
    return this.pools[pool].options.windowMs;
  }

  clear(): void {
    for (const name of Object.keys(this.pools) as P[]) {
      this.pools[name].clear();
      this.pools[name].saturatedUntilMs = Number.NEGATIVE_INFINITY;
    }
  }
}

/** Index of an earlier check naming the same pool and identity, or -1 (calls carry one or two checks). */
function duplicateOf<P extends string>(checks: readonly LocalWindowCheck<P>[], i: number): number {
  const c = checks[i] as LocalWindowCheck<P>;
  for (let j = 0; j < i; j++) {
    const d = checks[j] as LocalWindowCheck<P>;
    if (d.pool === c.pool && d.identity === c.identity) return j;
  }
  return -1;
}
