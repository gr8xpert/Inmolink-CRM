/**
 * In-process fixed-window counters (S8-F6): the fallback the website API keeps for when the limits Redis cannot answer.
 * The shared limiter fails open (a Redis outage must not take websites offline), so a process holds its own count of
 * what must stay bounded during an outage — form posts per key and browser (S8-F4), failed key checks per IP (S7-F9).
 *
 * - **Synchronous:** `reserve` checks and counts in one call, nothing interleaves; `release` gives a reservation back
 *   (once) when the shared limiter refuses, and forgets a window the reservation started that is back at 0.
 *   `peek` / `hit` are the single-identity, allocation-free pair.
 * - **Pools tracked apart:** each pool has its own map, bound and window length, so identities an attacker can multiply
 *   (one per IP) never evict a window in another pool (API keys). One length per pool keeps insertion order = expiry
 *   order, so the sweep stops at the first live window.
 * - **Never refuses for lack of room:** only a window at its limit refuses. A full pool sweeps expired windows, then
 *   evicts its oldest window still under its limit (looking at most `EVICT_SCAN` windows from the oldest); windows at
 *   their limit (boxed identities) are never evicted. If none is found the new identity goes **untracked** — allowed,
 *   and an untracked identity is never refused (`peek` answers 0), so a flood cannot lock out new identities.
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
}

export type LocalWindowReservation<P extends string = string> =
  | { allowed: true; release: () => void }
  | { allowed: false; check: LocalWindowCheck<P>; retryAfterSeconds: number };

/** Oldest windows a full pool looks at for one under its limit before leaving a new identity untracked. */
export const EVICT_SCAN = 64;

interface Window {
  expiresAtMs: number;
  count: number;
  limit: number;
}

class Pool {
  readonly map = new Map<string, Window>();

  constructor(readonly options: LocalPoolOptions) {}

  live(identity: string, now: number): Window | undefined {
    const w = this.map.get(identity);
    if (w === undefined) return undefined;
    if (now < w.expiresAtMs) return w;
    this.map.delete(identity);
    return undefined;
  }

  /**
   * Starts a window, or undefined (untracked) when the pool is full of windows at their limit. Never evicts a window
   * at its limit, nor `keep` (a window the same `reserve` already holds).
   */
  start(identity: string, limit: number, now: number, keep?: readonly (Window | undefined)[]): Window | undefined {
    if (this.map.size >= this.options.max) {
      this.sweep(now);
      if (this.map.size >= this.options.max && !this.evictOne(keep)) return undefined;
    }
    const w: Window = { expiresAtMs: now + this.options.windowMs, count: 0, limit };
    this.map.set(identity, w);
    return w;
  }

  /** Drops expired windows from the oldest on (insertion order is expiry order: one length per pool). */
  private sweep(now: number): void {
    for (const [identity, w] of this.map) {
      if (now < w.expiresAtMs) break;
      this.map.delete(identity);
    }
  }

  private evictOne(keep?: readonly (Window | undefined)[]): boolean {
    let scanned = 0;
    for (const [identity, w] of this.map) {
      if (scanned++ >= EVICT_SCAN) return false;
      if (w.count >= w.limit || keep?.includes(w)) continue;
      this.map.delete(identity);
      return true;
    }
    return false;
  }

  /** Forgets `w` if it is still this identity's window. */
  forget(identity: string, w: Window): void {
    if (this.map.get(identity) === w) this.map.delete(identity);
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
   * Takes one from every check, or none: refused (with the longest wait) when any tracked window is at its limit.
   * Checks naming the same pool and identity count once (the first one's limit applies).
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
      if (w && w.count >= check.limit) {
        const wait = waitSeconds(w.expiresAtMs, now);
        if (wait > refusedWait) {
          refused = check;
          refusedWait = wait;
        }
      }
    }
    if (refused) return { allowed: false, check: refused, retryAfterSeconds: refusedWait };
    let created = 0; // bit i: this reservation started check i's window
    for (let i = 0; i < n; i++) {
      const check = checks[i] as LocalWindowCheck<P>;
      if (duplicateOf(checks, i) >= 0) continue;
      let w = found[i];
      if (!w) {
        w = this.pools[check.pool].start(check.identity, check.limit, now, found);
        if (w) created |= 1 << i;
      }
      if (w) w.count += 1;
      found[i] = w;
    }
    let released = false;
    return {
      allowed: true,
      release: () => {
        if (released) return;
        released = true;
        for (let i = 0; i < n; i++) {
          const w = found[i];
          if (!w) continue;
          w.count = Math.max(0, w.count - 1);
          if (w.count === 0 && created & (1 << i)) {
            const check = checks[i] as LocalWindowCheck<P>;
            this.pools[check.pool].forget(check.identity, w);
          }
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
    w.count += 1;
    return true;
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
    for (const name of Object.keys(this.pools) as P[]) this.pools[name].map.clear();
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
