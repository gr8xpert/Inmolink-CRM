/**
 * Fakeable clock. Code reads time through `clock.now()` / `clock.nowMs()` only,
 * so tests can pin or advance it with `useFakeClock()` (or `vi.useFakeTimers()`,
 * which the system clock follows because it reads `Date.now()`).
 */
export interface Clock {
  nowMs(): number;
  now(): Date;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  now: () => new Date(Date.now()),
};

let current: Clock = systemClock;

/** The process clock. Delegates to whatever is installed (system by default). */
export const clock: Clock = {
  nowMs: () => current.nowMs(),
  now: () => current.now(),
};

export interface FakeClock extends Clock {
  set(time: Date | number | string): void;
  advance(ms: number): void;
}

export function createFakeClock(start: Date | number | string = 0): FakeClock {
  let t = toMs(start);
  return {
    nowMs: () => t,
    now: () => new Date(t),
    set: (time) => {
      t = toMs(time);
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

/** Installs a fake clock as the process clock. Call `restoreClock()` in `afterEach`. */
export function useFakeClock(start?: Date | number | string): FakeClock {
  const fake = createFakeClock(start ?? Date.now());
  current = fake;
  return fake;
}

export function restoreClock(): void {
  current = systemClock;
}

function toMs(time: Date | number | string): number {
  const ms = typeof time === 'number' ? time : new Date(time).getTime();
  if (!Number.isFinite(ms)) throw new RangeError(`Invalid time: ${String(time)}`);
  return ms;
}
