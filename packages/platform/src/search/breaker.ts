/**
 * Circuit breaker for the search engine (S5-04, PLAN §5.4, ADR 0005 #5). Per process: each instance decides alone,
 * from its own calls, whether the engine is usable.
 *
 * - **closed**: calls go to the engine. A failure — an error, a timeout, or an answer slower than `slowMs` — counts;
 *   `failureThreshold` in a row open the breaker. A good answer resets the count.
 * - **open**: calls skip the engine (the caller falls back) for `openMs`.
 * - **half-open**: after `openMs` one call probes the engine while the others keep falling back; its success closes
 *   the breaker, its failure opens it for another `openMs`.
 *
 * The breaker only decides and records: the caller times out its own engine call and reports the outcome.
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerOptions {
  /** Failures in a row that open the breaker. */
  failureThreshold: number;
  /** How long an open breaker skips the engine before it lets one probe through. */
  openMs: number;
  /** A successful answer slower than this counts as a failure ("slow" is as bad as "down" for a website). */
  slowMs: number;
  /** Called on every state change (log, metric). */
  onChange?: (to: BreakerState, from: BreakerState) => void;
  now?: () => number;
}

/** A permit to call the engine; report its outcome once with `success(ms)` or `failure()`. */
export interface BreakerPermit {
  success(elapsedMs: number): void;
  failure(): void;
}

export class CircuitBreaker {
  private current: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private probing = false;
  private probeAt = 0;
  private readonly now: () => number;

  constructor(private readonly options: BreakerOptions) {
    this.now = options.now ?? Date.now;
  }

  /** The state as of now (an open breaker past `openMs` reads half-open). */
  get state(): BreakerState {
    if (this.current === 'open' && this.now() - this.openedAt >= this.options.openMs) return 'half-open';
    return this.current;
  }

  /** A permit to call the engine, or null: fall back. Half-open lets one probe through at a time. */
  acquire(): BreakerPermit | null {
    const state = this.state;
    if (state === 'open') return null;
    if (state === 'half-open') {
      // A probe never reported (its caller died) stops blocking the next one after `openMs`.
      if (this.probing && this.now() - this.probeAt < this.options.openMs) return null;
      if (this.current !== 'half-open') this.move('half-open');
      this.probing = true;
      this.probeAt = this.now();
    }
    const probe = state === 'half-open';
    let settled = false;
    return {
      success: (elapsedMs) => {
        if (settled) return;
        settled = true;
        if (probe) this.probing = false;
        if (elapsedMs > this.options.slowMs) this.fail(probe);
        else this.succeed(probe);
      },
      failure: () => {
        if (settled) return;
        settled = true;
        if (probe) this.probing = false;
        this.fail(probe);
      },
    };
  }

  private succeed(probe: boolean): void {
    // Only the probe closes an open breaker: a late answer from before it opened says little about now.
    if (!probe && this.current !== 'closed') return;
    this.failures = 0;
    if (this.current !== 'closed') this.move('closed');
  }

  private fail(probe: boolean): void {
    this.failures += 1;
    // A failed probe reopens at once; a closed breaker opens at the threshold. A late answer from before the
    // breaker opened changes nothing.
    if (probe || (this.current === 'closed' && this.failures >= this.options.failureThreshold)) {
      this.openedAt = this.now();
      if (this.current !== 'open') this.move('open');
    }
  }

  private move(to: BreakerState): void {
    const from = this.current;
    this.current = to;
    this.options.onChange?.(to, from);
  }
}
