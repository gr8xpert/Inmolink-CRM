// pnpm perf:lighthouse [--url <url> …] [--min 90] [--portal-min-performance 80] [--desktop] [--json]
//
// Lighthouse CI for public pages (S7-F8, PLAN §15, frontend rules: performance, accessibility and SEO ≥ 90).
//
// - With `--url` (repeatable): audits those pages as they are served (staging: the iFrame embed search and detail).
// - Without: a local run — seeds an IFRAME site with own and network listings into the docker `test` stack, starts
//   the production build of apps/public (`pnpm --filter @inmolink/app-public build` first) on a loopback port with the
//   test env, and audits its embed search and detail pages, a selection page (`/s/<token>`) and the portal's search, location, listing
//   and development pages (S15-01). Search answers from the Postgres fallback there (the test
//   Meilisearch has no index of the seeded listings); the listings' photos are served by the test MinIO (no CDN).
//   Staging numbers (behind the CDN) are the reference.
//
// Mobile form factor with Lighthouse's simulated throttling (desktop with `--desktop`), `--runs` (3) per page, each
// number the median of the runs. Exits 1 when a page's median is below `--min` (90) in performance, accessibility or
// SEO, or its median LCP is at or over `--max-lcp-ms` (2000); best practices is reported only.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import lighthouse, { type Flags } from 'lighthouse';

const ROOT = join(import.meta.dirname, '..', '..');
const PORT = 54_115;
const DEVTOOLS_PORT = 54_116;
const CATEGORIES = ['performance', 'accessibility', 'seo', 'best-practices'] as const;
const GATED = new Set(['performance', 'accessibility', 'seo']);

const { values } = parseArgs({
  options: {
    url: { type: 'string', multiple: true },
    min: { type: 'string', default: '90' },
    /**
     * ADR 0019 (A): the portal's pages (locale-prefixed paths) keep the Next app-router pages and accept the framework's
     * hydration cost (~500 ms blocking time; 84–87 locally) until the staging measurement (H4). Their performance gate
     * is this level (noise margin below the measured medians); accessibility and SEO keep `--min`.
     */
    'portal-min-performance': { type: 'string', default: '80' },
    desktop: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    /** Lighthouse runs per page; each number reported (and gated) is the median of the runs. */
    runs: { type: 'string', default: '3' },
    /** The LCP budget (PLAN: < 2.0 s on mobile): a median LCP at or above it fails. */
    'max-lcp-ms': { type: 'string', default: '2000' },
    /**
     * Every audited page is `noindex` on purpose (iFrame embeds: the agency's own site is the indexed page): SEO is
     * scored without Lighthouse's "is crawlable" audit. A local run excuses it on its embed and selection pages only
     * (`NOINDEX_PATHS`); the portal's pages are indexed and scored with it (S15-01).
     */
    'allow-noindex': { type: 'boolean', default: false },
  },
});
const MIN = Number(values.min);
const PORTAL_MIN_PERFORMANCE = Number(values['portal-min-performance']);
/** The portal's pages: locale-prefixed paths (`/en/…`, `/es`) — ADR 0019 (A). */
const PORTAL_PATHS = /^\/[a-z]{2}(\/|$)/;
/** The minimum one category of one page must reach. */
function minimumFor(url: string, category: string): number {
  return category === 'performance' && PORTAL_PATHS.test(new URL(url).pathname) ? PORTAL_MIN_PERFORMANCE : MIN;
}
const RUNS = Math.max(1, Number(values.runs));
const MAX_LCP_MS = Number(values['max-lcp-ms']);

/** The median of numbers (the lower middle one for an even count). */
function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error(`${url} did not come up`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Local mode: an IFRAME site with listings in the test stack; returns the pages to audit and a stop function. */
async function localTarget(): Promise<{ urls: string[]; stop: () => Promise<void> }> {
  const nextDir = join(ROOT, 'apps', 'public', '.next');
  if (!existsSync(join(nextDir, 'BUILD_ID'))) {
    throw new Error('no production build of apps/public — run `pnpm --filter @inmolink/app-public build` first');
  }
  const { seedEmbedFixture } = await import('./lighthouse-fixture');
  const fixture = await seedEmbedFixture();
  const { testStackEnv } = await import('../../tests/e2e/stack');
  const base = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    ...testStackEnv(),
    // The production build, with the test stack's env (its dev keys are refused under NODE_ENV=production), like the
    // e2e web server.
    NODE_ENV: 'test',
    APP_ROLE: 'http',
    LOG_LEVEL: 'warn',
    PUBLIC_URL: base,
    // Unreachable on purpose: the Postgres fallback answers (no Meilisearch index of the fixture locally).
    MEILI_URL: 'http://127.0.0.1:9',
    // The fixture's photos, in the test MinIO's public media bucket.
    MEDIA_CDN_URL: `${testStackEnv().S3_ENDPOINT ?? 'http://localhost:59000'}/inmolink-media`,
    // Cloudflare's always-pass test keys: the detail page loads the Turnstile widget as in production.
    TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    TRUST_PROXY: 'loopback',
  };
  const nextBin = join(ROOT, 'apps', 'public', 'node_modules', 'next', 'dist', 'bin', 'next');
  const server: ChildProcess = spawn(process.execPath, [nextBin, 'start', '--port', String(PORT), '-H', '127.0.0.1'], {
    cwd: join(ROOT, 'apps', 'public'),
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitFor(`${base}/healthz`, 60_000);
  return {
    urls: [
      `${base}/embed/${fixture.siteId}/en`,
      `${base}/embed/${fixture.siteId}/en/listing/${fixture.ref}`,
      // S13-F13: the selection page a client opens from the agent's link.
      `${base}${fixture.selectionPath}`,
      // S15-01: the portal's search, location and listing pages (indexable: SEO counts "is crawlable" for them).
      `${base}${fixture.portal.searchPath}`,
      `${base}${fixture.portal.locationPath}`,
      `${base}${fixture.portal.listingPath}`,
      `${base}${fixture.portal.developmentPath}`,
    ],
    stop: async () => {
      server.kill();
      await fixture.close();
    },
  };
}

interface PageScores {
  url: string;
  scores: Record<string, number>;
  lcpMs: number | null;
  fcpMs: number | null;
  tbtMs: number | null;
  failing: string[];
  consoleErrors: string[];
  /** Each run's performance, LCP and TBT (the medians above are of these). */
  perRun?: { performance: number; lcpMs: number | null; tbtMs: number | null }[];
}

type Lhr = NonNullable<Awaited<ReturnType<typeof lighthouse>>>['lhr'];

/** A category's score (0–100), optionally without some audits (their weight left out, like Lighthouse's own mean). */
function categoryScore(lhr: Lhr, id: string, without: ReadonlySet<string>): number {
  const category = lhr.categories[id];
  if (!category) return 0;
  if (without.size === 0) return Math.round((category.score ?? 0) * 100);
  const refs = category.auditRefs.filter((r) => r.weight > 0 && !without.has(r.id));
  const weight = refs.reduce((sum, r) => sum + r.weight, 0);
  const total = refs.reduce((sum, r) => sum + r.weight * (lhr.audits[r.id]?.score ?? 0), 0);
  return weight === 0 ? 0 : Math.round((total / weight) * 100);
}

async function audit(urls: readonly string[]): Promise<PageScores[]> {
  const browser = await chromium.launch({ channel: 'chromium', args: [`--remote-debugging-port=${DEVTOOLS_PORT}`] });
  const flags: Flags = values.desktop
    ? {
        formFactor: 'desktop',
        screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
      }
    : { formFactor: 'mobile' };
  const out: PageScores[] = [];
  try {
    for (const url of urls) {
      // Warm the server (first render compiles nothing in production, but caches the site scope).
      await fetch(url).catch(() => undefined);
      const runs: PageScores[] = [];
      for (let run = 0; run < RUNS; run++) runs.push(await auditOnce(url, flags));
      const mid = (pick: (r: PageScores) => number | null) => {
        const xs = runs.map(pick).filter((x): x is number => x !== null);
        return xs.length > 0 ? median(xs) : null;
      };
      const byPerformance = [...runs].sort((x, y) => (x.scores.performance ?? 0) - (y.scores.performance ?? 0));
      out.push({
        url,
        scores: Object.fromEntries(CATEGORIES.map((c) => [c, mid((r) => r.scores[c] ?? 0) ?? 0])),
        lcpMs: mid((r) => r.lcpMs),
        fcpMs: mid((r) => r.fcpMs),
        tbtMs: mid((r) => r.tbtMs),
        failing: byPerformance[Math.floor((byPerformance.length - 1) / 2)]?.failing ?? [],
        consoleErrors: [...new Set(runs.flatMap((r) => r.consoleErrors))],
        perRun: runs.map((r) => ({ performance: r.scores.performance ?? 0, lcpMs: r.lcpMs, tbtMs: r.tbtMs })),
      });
    }
  } finally {
    await browser.close();
  }
  return out;
}

/** One Lighthouse run of a page. */
async function auditOnce(url: string, flags: Flags): Promise<PageScores> {
  const result = await lighthouse(url, {
    port: DEVTOOLS_PORT,
    logLevel: 'error',
    output: 'json',
    onlyCategories: [...CATEGORIES],
    ...flags,
  });
  const lhr = result?.lhr;
  if (!lhr) throw new Error(`Lighthouse returned no result for ${url}`);
  if (lhr.runtimeError) throw new Error(`${url}: ${lhr.runtimeError.message}`);
  // Local runs excuse only the pages that are noindex on purpose (embeds, selections); portal pages are indexed (S15-01).
  const noindexPage = values['allow-noindex'] || (local && NOINDEX_PATHS.test(new URL(url).pathname));
  const excused = new Set(noindexPage ? ['is-crawlable'] : []);
  const scores = Object.fromEntries(
    CATEGORIES.map((c) => [c, categoryScore(lhr, c, c === 'seo' ? excused : new Set())]),
  ) as Record<string, number>;
  const failing = Object.values(lhr.audits)
    .filter((a) => a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== 'informative')
    .map((a) => a.id);
  const ms = (id: string) => {
    const v = lhr.audits[id]?.numericValue;
    return typeof v === 'number' ? Math.round(v) : null;
  };
  const items = (lhr.audits['errors-in-console']?.details as { items?: { description?: string }[] } | undefined)?.items;
  const consoleErrors = (items ?? []).map((i) => String(i.description ?? '').slice(0, 200));
  return {
    url,
    scores,
    lcpMs: ms('largest-contentful-paint'),
    fcpMs: ms('first-contentful-paint'),
    tbtMs: ms('total-blocking-time'),
    failing,
    consoleErrors,
  };
}

const local = !values.url?.length;
/** Local pages that are `noindex` on purpose: iFrame embeds and selection links (S15-01: not the portal's). */
const NOINDEX_PATHS = /^\/(embed|s)\//;
const target = local ? await localTarget() : { urls: values.url ?? [], stop: async () => {} };
let results: PageScores[];
try {
  results = await audit(target.urls);
} finally {
  await target.stop();
}
if (values.json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log(
    `Lighthouse (${values.desktop ? 'desktop' : 'mobile'}, minimum ${MIN} for ${[...GATED].join(', ')}, portal performance ${PORTAL_MIN_PERFORMANCE} (ADR 0019)${values['allow-noindex'] ? '; SEO without is-crawlable: noindex on purpose' : local ? '; SEO without is-crawlable on the embed and selection pages (noindex on purpose)' : ''})`,
  );
  for (const r of results) {
    const path = new URL(r.url).pathname;
    console.log(
      `${path}\n  ${CATEGORIES.map((c) => `${c} ${r.scores[c]}`).join(' · ')} · FCP ${r.fcpMs ?? '?'} ms · LCP ${r.lcpMs ?? '?'} ms · TBT ${r.tbtMs ?? '?'} ms` +
        (r.failing.length > 0 ? `\n  below 0.9: ${r.failing.join(', ')}` : '') +
        (r.consoleErrors.length > 0 ? `\n  console: ${r.consoleErrors.join(' | ')}` : '') +
        (r.perRun
          ? `\n  runs: ${r.perRun.map((x) => `${x.performance} (LCP ${x.lcpMs} ms, TBT ${x.tbtMs} ms)`).join(' · ')}`
          : ''),
    );
  }
}
const low = results.flatMap((r) => [
  ...[...GATED]
    .filter((c) => (r.scores[c] ?? 0) < minimumFor(r.url, c))
    .map((c) => `${new URL(r.url).pathname}: ${c} ${r.scores[c]} (minimum ${minimumFor(r.url, c)})`),
  ...(r.lcpMs !== null && r.lcpMs >= MAX_LCP_MS ? [`${new URL(r.url).pathname}: LCP ${r.lcpMs} ms`] : []),
]);
if (low.length > 0) {
  console.error(`[S7-F8] perf:lighthouse: below the minimum or LCP ≥ ${MAX_LCP_MS} ms:\n  ${low.join('\n  ')}`);
  process.exit(1);
}
process.exit(0);
