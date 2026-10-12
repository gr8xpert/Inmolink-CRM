import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BUDGETS,
  checkBudget,
  displayRoute,
  formatTable,
  gzipSizer,
  KB,
  measureRoutes,
  parseClientReferenceManifest,
  readBuildManifests,
} from '../../scripts/perf/bundle-budget';

/** A fixture `.next` folder shaped like Next 16's Turbopack output. */
function fixture(): { dir: string; sizes: Record<string, number> } {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-budget-'));
  const chunks = join(dir, 'static', 'chunks');
  mkdirSync(chunks, { recursive: true });
  // Random bytes do not compress, so gzip sizes stay close to the raw sizes we want.
  const noise = (n: number) => randomBytes(n);
  const files: Record<string, Buffer> = {
    'static/chunks/framework.js': noise(140_000),
    'static/chunks/runtime.js': noise(5_000),
    'static/chunks/polyfill.js': noise(40_000),
    'static/chunks/layout.js': noise(10_000),
    'static/chunks/team.js': noise(20_000),
    'static/chunks/heavy.js': noise(120_000),
  };
  const sizes: Record<string, number> = {};
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(join(dir, name), bytes);
    sizes[name] = gzipSync(bytes, { level: 9 }).length;
  }
  writeFileSync(
    join(dir, 'build-manifest.json'),
    JSON.stringify({
      polyfillFiles: ['static/chunks/polyfill.js'],
      rootMainFiles: ['static/chunks/framework.js', 'static/chunks/runtime.js'],
    }),
  );
  const manifest = (route: string, entries: Record<string, string[]>) =>
    `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\nglobalThis.__RSC_MANIFEST[${JSON.stringify(route)}] = ${JSON.stringify({ moduleLoading: { prefix: '' }, clientModules: { 'x"}{': {} }, entryJSFiles: entries })};\n`;
  const write = (path: string, route: string, entries: Record<string, string[]>) => {
    mkdirSync(join(dir, 'server', 'app', path), { recursive: true });
    writeFileSync(join(dir, 'server', 'app', path, 'page_client-reference-manifest.js'), manifest(route, entries));
  };
  write('[locale]/(app)/(signed-in)/team', '/[locale]/(app)/(signed-in)/team/page', {
    '[project]/apps/web/src/app/[locale]/layout': ['static/chunks/layout.js', 'static/chunks/runtime.js'],
    '[project]/apps/web/src/app/[locale]/(app)/(signed-in)/team/page': [
      'static/chunks/layout.js',
      'static/chunks/team.js',
    ],
  });
  write('[locale]/(app)/heavy', '/[locale]/(app)/heavy/page', {
    '[project]/apps/web/src/app/[locale]/(app)/heavy/page': ['static/chunks/heavy.js', 'static/chunks/team.js'],
  });
  write('_not-found', '/_not-found/page', { x: ['static/chunks/heavy.js'] });
  return { dir, sizes };
}

const { dir, sizes } = fixture();
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const size = (...names: string[]) => names.reduce((sum, n) => sum + (sizes[`static/chunks/${n}.js`] ?? 0), 0);

describe('perf:bundle', () => {
  it('[S1-10] reads first-load JS per route from the build manifests: framework + each entry chunk once, nomodule polyfills and internal routes excluded', () => {
    const manifests = readBuildManifests(dir);
    expect(manifests.frameworkFiles).toEqual(['static/chunks/framework.js', 'static/chunks/runtime.js']);
    const routes = measureRoutes(manifests, gzipSizer(dir), BUDGETS.dashboard);
    expect(routes.map((r) => displayRoute(r.route))).toEqual(['/[locale]/heavy', '/[locale]/team']);
    const team = routes.find((r) => r.route.endsWith('/team/page'));
    expect(team).toMatchObject({
      framework: size('framework', 'runtime'),
      routeOnly: size('layout', 'team'), // layout.js listed twice, counted once; runtime.js is framework
      total: size('framework', 'runtime', 'layout', 'team'),
      failures: [],
    });
  });

  it('[S1-10] dashboard route first-load JS over 250 KB gzip fails the check', () => {
    const routes = measureRoutes(readBuildManifests(dir), gzipSizer(dir), BUDGETS.dashboard);
    const heavy = routes.find((r) => r.route.endsWith('/heavy/page'));
    expect(heavy?.total).toBe(size('framework', 'runtime', 'heavy', 'team'));
    expect(heavy?.total).toBeGreaterThan(250 * KB);
    expect(heavy?.failures).toEqual([expect.stringMatching(/^first-load JS .* > 250\.0 KB$/)]);
    expect(formatTable('apps/web', BUDGETS.dashboard, routes)).toMatch(/\/\[locale\]\/heavy .*FAIL/);
  });

  it('[S1-10] public routes: framework ≤ 149 KB and route JS ≤ 30 KB are checked separately (ADR 0013)', () => {
    expect(checkBudget({ framework: 145 * KB, routeOnly: 29 * KB, total: 174 * KB }, BUDGETS.public)).toEqual([]);
    expect(checkBudget({ framework: 150 * KB, routeOnly: 10 * KB, total: 160 * KB }, BUDGETS.public)).toEqual([
      'framework JS 150.0 KB > 149.0 KB',
    ]);
    expect(checkBudget({ framework: 140 * KB, routeOnly: 31 * KB, total: 171 * KB }, BUDGETS.public)).toEqual([
      'route JS 31.0 KB > 30.0 KB',
    ]);
    // The dashboard limit is on the total only.
    expect(checkBudget({ framework: 140 * KB, routeOnly: 110 * KB, total: 250 * KB }, BUDGETS.dashboard)).toEqual([]);
  });

  it('[S1-10] parses manifests without evaluating them, braces inside strings included', () => {
    const src = `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\nglobalThis.__RSC_MANIFEST["/a/page"] = {"clientModules":{"q\\"}{":1},"entryJSFiles":{"x":["a.js"],"y":["a.js","b.js"]}};\n`;
    expect(parseClientReferenceManifest(src)).toEqual([{ route: '/a/page', files: ['a.js', 'b.js'] }]);
    expect(() => readBuildManifests(join(dir, 'missing'))).toThrow(/no production build/);
  });
});
