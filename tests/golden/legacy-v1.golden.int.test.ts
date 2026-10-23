import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_KEY_PARAM, legacyShimPath } from '@inmolink/contracts';
import * as migration from '@inmolink/core/modules/migration';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type GoldenFile, goldenCoverage, normalizeJson, normalizeText } from '../../scripts/legacy-api/record';
import type { TrafficReport } from '../../scripts/legacy-api/traffic';
import { type FeedApp, type Fixture, loadWorld, startWorld, stopWorld } from './world';

/**
 * Legacy API golden parity (S8-02, PLAN §9.3: "CI asserts 100% golden-file parity"). Replays every golden file against
 * the v1 shim (feed-api's `/v1/*`, the legacy path rewritten as at cutover: `/api/…` → `/v1/…`) and compares the
 * normalized answer byte for byte — status, content type and body, normalized exactly as the recorder does (sorted
 * keys, volatile fields `<volatile>`, the fixture's base URL `{LEGACY_BASE}`).
 *
 * - **Recorded** golden files (`tests/golden/<endpoint>/<case>.json`, `pnpm legacy:record`, S8-01 / H2) replay against
 *   `tests/golden/fixture.json`: the public read-path rows of the H2 test account as the legacy migration loaded them
 *   (S14). None exist yet, so this check passes with no case; the moment one is added it must match.
 * - **Synthetic** golden files (`tests/golden/synthetic/…`, `"synthetic": true`) replay against
 *   `tests/golden/synthetic/fixture.json`. They encode the ASSUMED legacy contract (contracts `legacy-v1.ts`) and are
 *   HAND-DERIVED from that fixture (the contract's rules applied to its rows by a script of their own, never from the
 *   shim's output) — not recorded answers. Delete them once the recorded set covers the 99% traffic set.
 * - **Coverage:** with `tests/golden/traffic.json` (`pnpm legacy:traffic`), every endpoint of its 99% set needs a
 *   recorded golden file.
 *
 * Updating a golden file needs a STATUS note (testing rules); `/v1` is frozen once recorded parity holds.
 */

const GOLDEN = import.meta.dirname;
const SYNTHETIC = join(GOLDEN, 'synthetic');

/** Golden files of `dir`'s endpoint folders (`<dir>/<endpoint>/<case>.json`), in a stable order. */
function goldenFiles(dir: string, skip: readonly string[] = []): GoldenFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !skip.includes(d.name))
    .sort((x, y) => x.name.localeCompare(y.name))
    .flatMap((d) =>
      readdirSync(join(dir, d.name))
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => JSON.parse(readFileSync(join(dir, d.name, f), 'utf8')) as GoldenFile),
    );
}

let app: FeedApp;

/** The shim's answer to a golden request, normalized like the recorder normalizes the legacy one. */
async function replay(golden: GoldenFile, key: string, base: string | null): Promise<GoldenFile['response']> {
  const query = new URLSearchParams({ ...golden.request.query, [LEGACY_KEY_PARAM]: key });
  const res = await app.inject({
    method: golden.request.method as 'GET' | 'HEAD',
    url: `${legacyShimPath(golden.request.path)}?${query.toString()}`,
  });
  const contentType = String(res.headers['content-type'] ?? '')
    .split(';')[0]
    ?.trim() as string;
  const out: GoldenFile['response'] = { status: res.statusCode, contentType };
  let json: unknown;
  if (contentType.includes('json')) {
    try {
      json = JSON.parse(res.body);
    } catch {
      json = undefined;
    }
  }
  if (json !== undefined) out.json = normalizeJson(json, base ?? '');
  else out.text = normalizeText(res.body, base ?? '');
  return out;
}

/** Every case of a set against its fixture: the mismatches (none for 100% parity). */
async function parity(cases: readonly GoldenFile[], fixture: Fixture) {
  const { key } = await loadWorld(fixture);
  migration.resetLegacyIdCache();
  const failures: { case: string; expected: string; actual: string }[] = [];
  for (const golden of cases) {
    const actual = JSON.stringify(await replay(golden, key, fixture.base), null, 2);
    const expected = JSON.stringify(golden.response, null, 2);
    if (actual !== expected) failures.push({ case: `${golden.endpoint} ${golden.case}`, expected, actual });
  }
  return failures;
}

beforeAll(async () => {
  app = await startWorld('golden');
}, 180_000);

afterAll(() => stopWorld(app));

const recorded = goldenFiles(GOLDEN, ['synthetic']);
const trafficPath = join(GOLDEN, 'traffic.json');

it(
  recorded.length === 0
    ? '[S8-02] PENDING (H2): no recorded legacy golden file yet — the 100% parity check is armed for the first one'
    : '[S8-02] 100% golden-file parity: every recorded legacy golden file matches the v1 shim byte for byte',
  async () => {
    if (existsSync(trafficPath)) {
      // The traffic report's 99% set: each endpoint needs a recorded golden file.
      const report = JSON.parse(readFileSync(trafficPath, 'utf8')) as TrafficReport;
      expect(goldenCoverage(report, GOLDEN).missing).toEqual([]);
    }
    if (recorded.length === 0) return;
    const fixturePath = join(GOLDEN, 'fixture.json');
    expect(existsSync(fixturePath), 'recorded golden files need tests/golden/fixture.json (their read-path rows)').toBe(
      true,
    );
    const failures = await parity(recorded, JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture);
    for (const f of failures) expect(f.actual, f.case).toBe(f.expected);
    expect(failures).toEqual([]);
  },
);

it('[S8-02] synthetic golden files (assumed legacy contract) match the v1 shim byte for byte', async () => {
  const fixture = JSON.parse(readFileSync(join(SYNTHETIC, 'fixture.json'), 'utf8')) as Fixture;
  const cases = goldenFiles(SYNTHETIC);
  expect(fixture.synthetic).toBe(true);
  expect(cases.length).toBeGreaterThan(0);
  expect(cases.every((c) => (c as GoldenFile & { synthetic?: boolean }).synthetic === true)).toBe(true);
  const failures = await parity(cases, fixture);
  for (const f of failures) expect(f.actual, f.case).toBe(f.expected);
  expect(failures).toEqual([]);
});
