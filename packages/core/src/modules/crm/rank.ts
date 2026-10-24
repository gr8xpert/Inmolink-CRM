/**
 * Board ranks (S10-03): a lead's place in its pipeline column is a base-36 fraction written as its digits
 * (`0-9a-z`, `leads.stage_rank`, `COLLATE "C"`), compared as strings: `'4'` < `'4i'` < `'5'`. A key never ends in `0`,
 * so between any two keys there is another (`rankBetween`) and a drag rewrites one row — no renumbering, no lock on
 * the column. Keys grow by about one digit per five drops into the same gap.
 *
 * A lead entering a stage without a drag gets a time key (`timeRank`, the same as `leads_stage_sync` in SQL): the
 * newest sorts first.
 */

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;
/** 36^9 - 1: time keys are 9 digits of (this - epoch ms), valid until the year 5188. */
const TIME_TOP = 101_559_956_668_415;
export const RANK_MAX_CHARS = 200;

const digit = (c: string | undefined): number => (c === undefined ? 0 : DIGITS.indexOf(c));

/** A valid rank: base-36 digits, at least one, not ending in `0`. */
export function isRank(key: string): boolean {
  return /^[0-9a-z]*[1-9a-z]$/.test(key) && key.length <= RANK_MAX_CHARS;
}

/**
 * A key strictly between `a` and `b` (`a` = `''`: before everything; `b` = null: after everything); `a < b` and
 * neither ends in `0`.
 */
export function rankBetween(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`rankBetween: ${a} >= ${b}`);
  if (b !== null) {
    let n = 0;
    while (n < b.length && (a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + rankBetween(a.slice(n), b.slice(n));
  }
  const da = digit(a[0]);
  const db = b !== null ? digit(b[0]) : BASE;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)] as string;
  // adjacent first digits: b's first digit alone sits between when b goes on; otherwise keep a's and go deeper
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return (DIGITS[da] as string) + rankBetween(a.slice(1), null);
}

/** The time key of a lead entering a stage at `at` (newest first), as `leads_stage_sync` writes it. */
export function timeRank(at: Date, id: string): string {
  let n = TIME_TOP - Math.trunc(at.getTime());
  let key = '';
  for (let i = 0; i < 9; i++) {
    key = (DIGITS[n % BASE] as string) + key;
    n = Math.floor(n / BASE);
  }
  return `${key}${id.replaceAll('-', '').slice(-4)}i`;
}

/**
 * The `index`-th of `total` evenly spread keys (a rebalanced column): fixed-width base-36 digits of `index + 1`, then
 * `i` — strictly increasing, short, never ending in `0`, with room between each two.
 */
export function spreadRank(index: number, total: number): string {
  let width = 1;
  while (BASE ** width <= total) width++;
  return `${(index + 1).toString(BASE).padStart(width, '0')}i`;
}
