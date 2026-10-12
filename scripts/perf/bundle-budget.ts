// First-load JavaScript per route of a Next.js production build (S1-10, ADR 0013).
//
// Next 16 (Turbopack) no longer prints first-load sizes, so we compute them from the build output:
// - `.next/build-manifest.json` → `rootMainFiles`: the framework and runtime chunks every app route
//   loads (react-dom, the app router). `polyfillFiles` are `nomodule` scripts that modern browsers
//   skip, so they are not counted (as in ADR 0013's measurement).
// - `.next/server/app/**/page_client-reference-manifest.js` → `entryJSFiles`: per route, the client
//   chunks of each layout, template, boundary and page on the way to it.
// A route's first-load JS is the union of both sets, each file gzipped (level 9) and summed.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

export const KB = 1000;

export type BudgetKind = 'dashboard' | 'public';

export interface Budget {
  kind: BudgetKind;
  /** Dashboard: whole first-load JS per route, bytes gzip (CLAUDE.md: 250 KB). */
  totalMax?: number;
  /** Public: framework floor, bytes gzip (ADR 0013: 141.7 KB + 5% = 149 KB). */
  frameworkMax?: number;
  /** Public: route code on top of the framework, bytes gzip (ADR 0013: 30 KB). */
  routeMax?: number;
}

export const BUDGETS: Record<BudgetKind, Budget> = {
  dashboard: { kind: 'dashboard', totalMax: 250 * KB },
  public: { kind: 'public', frameworkMax: 149 * KB, routeMax: 30 * KB },
};

export interface RouteManifest {
  /** App route, e.g. `/[locale]/(app)/(signed-in)/team/page`. */
  route: string;
  files: string[];
}

export interface BuildManifests {
  frameworkFiles: string[];
  routes: RouteManifest[];
}

export interface RouteSize {
  route: string;
  /** Gzip bytes of the shared framework chunks. */
  framework: number;
  /** Gzip bytes of the route's own chunks (not in the framework set). */
  routeOnly: number;
  total: number;
  failures: string[];
}

/** `globalThis.__RSC_MANIFEST["<route>"] = {…};` → route and its JSON, without evaluating the file. */
export function parseClientReferenceManifest(source: string): RouteManifest[] {
  const out: RouteManifest[] = [];
  const marker = /globalThis\.__RSC_MANIFEST\[("(?:[^"\\]|\\.)*")\]\s*=\s*/g;
  for (let m = marker.exec(source); m; m = marker.exec(source)) {
    const route = JSON.parse(m[1] as string) as string;
    const start = marker.lastIndex;
    const end = jsonObjectEnd(source, start);
    const json = JSON.parse(source.slice(start, end)) as { entryJSFiles?: Record<string, string[]> };
    const files = new Set<string>();
    for (const list of Object.values(json.entryJSFiles ?? {})) for (const f of list) files.add(f);
    out.push({ route, files: [...files] });
    marker.lastIndex = end;
  }
  return out;
}

/** Index just past the JSON object that starts at `start` (string-aware brace matching). */
function jsonObjectEnd(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  throw new Error('unterminated client reference manifest');
}

/** Reads the manifests of a `.next` folder (throws when there is no production build). */
export function readBuildManifests(nextDir: string): BuildManifests {
  const buildManifest = join(nextDir, 'build-manifest.json');
  if (!existsSync(buildManifest)) throw new Error(`no production build in ${nextDir} (run next build first)`);
  const { rootMainFiles = [] } = JSON.parse(readFileSync(buildManifest, 'utf8')) as { rootMainFiles?: string[] };
  const appDir = join(nextDir, 'server', 'app');
  const routes: RouteManifest[] = [];
  if (existsSync(appDir)) {
    const files = readdirSync(appDir, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith(`page_client-reference-manifest.js`),
    );
    for (const f of files.sort()) routes.push(...parseClientReferenceManifest(readFileSync(join(appDir, f), 'utf8')));
  }
  return { frameworkFiles: rootMainFiles, routes };
}

/** Next's internal routes (`/_not-found`, `/_global-error`) are not pages anyone navigates to. */
export function isInternalRoute(route: string): boolean {
  return route.startsWith('/_');
}

/** Gzipped size of a file under `.next/`, read once per run. */
export function gzipSizer(nextDir: string): (file: string) => number {
  const cache = new Map<string, number>();
  return (file) => {
    let size = cache.get(file);
    if (size === undefined) {
      size = gzipSync(readFileSync(join(nextDir, file)), { level: 9 }).length;
      cache.set(file, size);
    }
    return size;
  };
}

/** Sizes every non-internal route and checks it against `budget`. */
export function measureRoutes(
  manifests: BuildManifests,
  sizeOf: (file: string) => number,
  budget: Budget,
): RouteSize[] {
  const framework = new Set(manifests.frameworkFiles);
  const frameworkBytes = [...framework].reduce((sum, f) => sum + sizeOf(f), 0);
  return manifests.routes
    .filter((r) => !isInternalRoute(r.route))
    .map((r) => {
      const own = [...new Set(r.files)].filter((f) => !framework.has(f));
      const routeOnly = own.reduce((sum, f) => sum + sizeOf(f), 0);
      const size = { route: r.route, framework: frameworkBytes, routeOnly, total: frameworkBytes + routeOnly };
      return { ...size, failures: checkBudget(size, budget) };
    })
    .sort((a, b) => displayRoute(a.route).localeCompare(displayRoute(b.route)));
}

export function checkBudget(size: Omit<RouteSize, 'route' | 'failures'>, budget: Budget): string[] {
  const failures: string[] = [];
  if (budget.totalMax !== undefined && size.total > budget.totalMax) {
    failures.push(`first-load JS ${kb(size.total)} > ${kb(budget.totalMax)}`);
  }
  if (budget.frameworkMax !== undefined && size.framework > budget.frameworkMax) {
    failures.push(`framework JS ${kb(size.framework)} > ${kb(budget.frameworkMax)}`);
  }
  if (budget.routeMax !== undefined && size.routeOnly > budget.routeMax) {
    failures.push(`route JS ${kb(size.routeOnly)} > ${kb(budget.routeMax)}`);
  }
  return failures;
}

export function kb(bytes: number): string {
  return `${(bytes / KB).toFixed(1)} KB`;
}

/** `/[locale]/(app)/(signed-in)/team/page` → `/[locale]/team` (the URL; route groups and `/page` dropped). */
export function displayRoute(route: string): string {
  const path = route
    .replace(/\/page$/, '')
    .split('/')
    .filter((s) => !/^\(.*\)$/.test(s))
    .join('/');
  return path || '/';
}

export function formatTable(app: string, budget: Budget, sizes: RouteSize[]): string {
  const limit =
    budget.kind === 'dashboard'
      ? `total ≤ ${kb(budget.totalMax ?? 0)}`
      : `framework ≤ ${kb(budget.frameworkMax ?? 0)}, route ≤ ${kb(budget.routeMax ?? 0)}`;
  const rows = sizes.map((s) => [
    displayRoute(s.route),
    kb(s.framework),
    kb(s.routeOnly),
    kb(s.total),
    s.failures.length ? `FAIL: ${s.failures.join('; ')}` : 'ok',
  ]);
  const head = ['route', 'framework', 'route JS', 'first load', 'status'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i > 0 && i < 4 ? c.padStart(widths[i] ?? 0) : c.padEnd(widths[i] ?? 0))).join('  ');
  return [`${app} (${budget.kind}: ${limit}, gzip)`, line(head), ...rows.map(line)].join('\n');
}

/** Path of a build folder relative to the repo, for messages. */
export function shown(root: string, dir: string): string {
  return relative(root, dir).split(sep).join('/');
}
