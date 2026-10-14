// pnpm perf:bundle [--if-present] [--json]
//
// First-load JS budgets per route, from the production builds (S1-10): `apps/web` against the dashboard
// budget (≤ 250 KB gzip per route), `apps/public` against ADR 0013 (framework ≤ 149 KB, route ≤ 30 KB).
// Run after `next build` (`pnpm build`). Exits 1 when a route is over budget, or when the web build is
// missing — unless `--if-present` (CI on pull requests builds only affected apps).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUDGETS,
  type Budget,
  formatTable,
  gzipSizer,
  measureRoutes,
  type RouteSize,
  readBuildManifests,
  shown,
} from './bundle-budget';

const ROOT = join(import.meta.dirname, '..', '..');
const args = new Set(process.argv.slice(2));
const ifPresent = args.has('--if-present');

const APPS: ReadonlyArray<{ app: string; budget: Budget; required: boolean }> = [
  { app: 'web', budget: BUDGETS.dashboard, required: true },
  { app: 'public', budget: BUDGETS.public, required: false },
];

let failed = false;
const report: Record<string, RouteSize[]> = {};
for (const { app, budget, required } of APPS) {
  const nextDir = join(ROOT, 'apps', app, '.next');
  if (!existsSync(join(nextDir, 'build-manifest.json'))) {
    const msg = `${shown(ROOT, nextDir)}: no production build`;
    if (required && !ifPresent) {
      console.error(`${msg} — run \`pnpm build\` (or \`pnpm --filter @inmolink/app-${app} build\`) first.`);
      failed = true;
    } else {
      console.log(`${msg}, skipped.`);
    }
    continue;
  }
  const sizes = measureRoutes(readBuildManifests(nextDir), gzipSizer(nextDir), budget);
  report[app] = sizes;
  if (!args.has('--json')) console.log(`${formatTable(`apps/${app}`, budget, sizes)}\n`);
  if (sizes.length === 0) console.log(`apps/${app}: no app routes found in the build.`);
  if (sizes.some((s) => s.failures.length > 0)) failed = true;
}
if (args.has('--json')) console.log(JSON.stringify(report, null, 2));
if (failed) {
  console.error(
    '[S1-10] perf:bundle: over budget (or no build). Move heavy UI behind next/dynamic, drop the dependency, or',
  );
  console.error('record a reviewed exception in STATUS.');
  process.exit(1);
}
