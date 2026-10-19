import { describe, expect, it } from 'vitest';
import { type BreakerState, CircuitBreaker } from './breaker';

function setup() {
  let t = 0;
  const changes: string[] = [];
  const breaker = new CircuitBreaker({
    failureThreshold: 3,
    openMs: 10_000,
    slowMs: 500,
    now: () => t,
    onChange: (to: BreakerState, from: BreakerState) => changes.push(`${from}>${to}`),
  });
  return { breaker, changes, advance: (ms: number) => (t += ms) };
}

const fail = (b: CircuitBreaker, n: number) => {
  for (let i = 0; i < n; i++) b.acquire()?.failure();
};

describe('platform/search circuit breaker', () => {
  it('[S5-04] opens after consecutive failures; a success in between resets the count', () => {
    const { breaker, changes } = setup();
    fail(breaker, 2);
    breaker.acquire()?.success(10);
    fail(breaker, 2);
    expect(breaker.state).toBe('closed');
    fail(breaker, 1);
    expect(breaker.state).toBe('open');
    expect(breaker.acquire()).toBeNull();
    expect(changes).toEqual(['closed>open']);
  });

  it('[S5-04] a slow answer counts as a failure (slow is down for a website)', () => {
    const { breaker } = setup();
    for (let i = 0; i < 3; i++) breaker.acquire()?.success(501);
    expect(breaker.state).toBe('open');
  });

  it('[S5-04] after the open period one probe goes through; its success closes the breaker', () => {
    const { breaker, changes, advance } = setup();
    fail(breaker, 3);
    advance(9_999);
    expect(breaker.acquire()).toBeNull();
    advance(1);
    expect(breaker.state).toBe('half-open');
    const probe = breaker.acquire();
    expect(probe).not.toBeNull();
    // others keep falling back while the probe is out
    expect(breaker.acquire()).toBeNull();
    probe?.success(20);
    expect(breaker.state).toBe('closed');
    expect(breaker.acquire()).not.toBeNull();
    expect(changes).toEqual(['closed>open', 'open>half-open', 'half-open>closed']);
  });

  it('[S5-04] a failed probe reopens for another period', () => {
    const { breaker, advance } = setup();
    fail(breaker, 3);
    advance(10_000);
    breaker.acquire()?.failure();
    expect(breaker.state).toBe('open');
    advance(5_000);
    expect(breaker.acquire()).toBeNull();
    advance(5_000);
    expect(breaker.acquire()).not.toBeNull();
  });

  it('[S5-04] late answers from before the breaker opened change nothing; a lost probe stops blocking', () => {
    const { breaker, advance } = setup();
    const late = breaker.acquire();
    fail(breaker, 3);
    late?.success(5);
    expect(breaker.state).toBe('open');
    late?.failure(); // reported twice: ignored
    advance(10_000);
    expect(breaker.acquire()).not.toBeNull(); // probe never reported
    expect(breaker.acquire()).toBeNull();
    advance(10_000);
    expect(breaker.acquire()).not.toBeNull();
  });

  it('[S6-F3] a slow-or-failed share over the window opens the breaker, though never enough fail in a row', () => {
    let t = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 5,
      openMs: 10_000,
      slowMs: 80,
      window: { windowMs: 10_000, minCalls: 10, failureRatio: 0.5 },
      now: () => t,
    });
    // Slow, fast, slow, fast…: never 5 in a row; the window opens it once 10 calls are in and half failed.
    for (let i = 0; i < 9; i++) {
      breaker.acquire()?.success(i % 2 === 0 ? 200 : 10);
      t += 100;
    }
    expect(breaker.state).toBe('closed');
    breaker.acquire()?.success(10);
    expect(breaker.state).toBe('closed'); // 10 calls, 5 slow: the share is checked on a failure
    breaker.acquire()?.success(200);
    expect(breaker.state).toBe('open');
  });

  it('[S6-F3] outcomes older than the window no longer count; a closed breaker starts a fresh window', () => {
    let t = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 100,
      openMs: 1_000,
      slowMs: 80,
      window: { windowMs: 10_000, minCalls: 4, failureRatio: 0.75 },
      now: () => t,
    });
    for (let i = 0; i < 3; i++) breaker.acquire()?.failure();
    t += 11_000; // the three failures leave the window
    breaker.acquire()?.success(10);
    breaker.acquire()?.failure();
    expect(breaker.state).toBe('closed'); // 2 calls in the window
    for (let i = 0; i < 2; i++) breaker.acquire()?.failure();
    expect(breaker.state).toBe('open'); // 4 calls, 3 failed
    t += 1_000;
    breaker.acquire()?.success(10); // the probe closes it
    expect(breaker.state).toBe('closed');
    for (let i = 0; i < 3; i++) breaker.acquire()?.failure();
    expect(breaker.state).toBe('closed'); // the old window's outcomes are gone: 3 calls < 4
  });
});
