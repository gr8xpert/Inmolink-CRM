/**
 * In-process caps on website form posts (S8-F4): the fallback when the limits Redis cannot answer. The shared limiter
 * fails open (a Redis outage must not take websites offline), so without this a leaked secret key stating
 * `serverVerified: true` could post leads — and trigger acknowledgement e-mails — without bound during an outage.
 *
 * - **Same limits as the shared form-spam rules**, fixed windows: per key (`leadsPerKeyHour[tier]` per hour, secret and
 *   publishable keys alike) and per browser (key × client IP, `leadsPerBrowser` per `leadWindowSeconds`). One process
 *   never counts more than the shared rule, so while Redis answers the shared rule denies first; the local count bites
 *   when the shared one fails open (the publishable per-key cap has no shared twin: it alone can refuse a widget site
 *   posting more than `leadsPerKeyHour` leads an hour through one process).
 * - **Per process:** with N feed-api processes an outage lets up to N × the cap through per key — bounded, not exact.
 * - **Reserved synchronously** (`reserve`, before the limiter's round trip) and released when the shared limiter refuses,
 *   so concurrent posts during a slow or hanging Redis cannot all pass one check.
 * - **Keys and browsers are tracked apart:** browser identities (an attacker can make many: one per IP bucket) never
 *   evict a key's window. Each map holds at most `MAX_TRACKED` windows; expired ones are swept first; a full browser
 *   map refuses new browsers rather than forgetting live windows; a full key map (more keys posting in an hour than
 *   that) drops its oldest window.
 * - **Not covered:** the iFrame embed pages' lead posts (`checkEmbedLimits`): each needs a Turnstile token solved on
 *   the public origin (fail closed without Turnstile), and acknowledgements are capped per site and day in the database.
 */
import { clock } from '@inmolink/platform/clock';

export interface LocalCap {
  identity: string;
  limit: number;
  windowMs: number;
  /** `key`: one per API key (never evicted by browser traffic); `browser`: key × client IP. */
  pool: 'key' | 'browser';
}

export type LocalReservation =
  | { allowed: true; release: () => void }
  | { allowed: false; cap: LocalCap; retryAfterSeconds: number };

interface Window {
  expiresAtMs: number;
  count: number;
}

class Windows {
  readonly map = new Map<string, Window>();

  constructor(readonly max: number) {}

  live(identity: string, now: number): Window | undefined {
    const w = this.map.get(identity);
    if (w && now < w.expiresAtMs) return w;
    if (w) this.map.delete(identity);
    return undefined;
  }

  /** Drops expired windows from the oldest on (insertion order is start order; one window length per pool). */
  sweep(now: number): void {
    for (const [identity, w] of this.map) {
      if (now < w.expiresAtMs) break;
      this.map.delete(identity);
    }
  }

  /** The oldest live window's remaining seconds (a full map's wait). */
  oldestWaitSeconds(now: number): number {
    const first = this.map.values().next().value;
    return Math.max(1, Math.ceil(((first?.expiresAtMs ?? now) - now) / 1_000));
  }
}

export class LocalWriteCaps {
  static readonly MAX_TRACKED = 10_000;
  private readonly keys: Windows;
  private readonly browsers: Windows;

  constructor(maxTracked = LocalWriteCaps.MAX_TRACKED) {
    this.keys = new Windows(maxTracked);
    this.browsers = new Windows(maxTracked);
  }

  /**
   * Takes one post from every cap, or none: refused (with the longest wait) when any cap is used up, or when a new
   * browser finds the browser map full of live windows. Synchronous — nothing can interleave between check and count.
   */
  reserve(caps: readonly LocalCap[]): LocalReservation {
    const now = clock.nowMs();
    const found: (Window | undefined)[] = [];
    let refused: { cap: LocalCap; retryAfterSeconds: number } | undefined;
    for (const cap of caps) {
      const pool = this.pool(cap);
      const w = pool.live(cap.identity, now);
      found.push(w);
      let wait = 0;
      if (w && w.count >= cap.limit) wait = Math.max(1, Math.ceil((w.expiresAtMs - now) / 1_000));
      else if (!w && cap.pool === 'browser' && pool.map.size >= pool.max) {
        pool.sweep(now);
        if (pool.map.size >= pool.max) wait = pool.oldestWaitSeconds(now);
      }
      if (wait > 0 && (!refused || wait > refused.retryAfterSeconds)) refused = { cap, retryAfterSeconds: wait };
    }
    if (refused) return { allowed: false, ...refused };
    const taken = caps.map((cap, i) => {
      const existing = found[i];
      if (existing) {
        existing.count += 1;
        return existing;
      }
      const pool = this.pool(cap);
      if (pool.map.size >= pool.max) pool.sweep(now);
      if (pool.map.size >= pool.max) {
        const oldest = pool.map.keys().next().value;
        if (oldest !== undefined) pool.map.delete(oldest);
      }
      const w: Window = { expiresAtMs: now + cap.windowMs, count: 1 };
      pool.map.set(cap.identity, w);
      return w;
    });
    let released = false;
    return {
      allowed: true,
      release: () => {
        if (released) return;
        released = true;
        for (const w of taken) w.count = Math.max(0, w.count - 1);
      },
    };
  }

  private pool(cap: LocalCap): Windows {
    return cap.pool === 'key' ? this.keys : this.browsers;
  }

  /** Windows tracked: keys and browsers. */
  get size(): { keys: number; browsers: number } {
    return { keys: this.keys.map.size, browsers: this.browsers.map.size };
  }

  clear(): void {
    this.keys.map.clear();
    this.browsers.map.clear();
  }
}
