/**
 * One feed run of `feed-import.int.test.ts` in a process of its own (S6-02): what the `imports` worker runs —
 * `imports.executeRun` with the listing loader — so its peak RSS is the worker's, not the test's (which generated the
 * 100 MB feed and serves it). Plain `node` on the built packages, like `media-burst.child.ts` (S4-F2). The stack env
 * comes from the parent; argv[2] is `{ runId, agencyId }`. Prints one JSON line:
 * `{ base, peak, maxRss, ms, outcome }`.
 */

import type { FeedListingInput } from '@inmolink/contracts';
import * as imports from '@inmolink/core/modules/imports';
import { closeDb } from '@inmolink/db';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { createLogger } from '@inmolink/platform/logger';
import { allowLoopbackOriginsForTests } from '@inmolink/platform/safe-fetch';
import { childOf, childText, type XmlElement } from '@inmolink/platform/xml';

const { runId, agencyId, origin } = JSON.parse(process.argv[2] ?? '{}') as {
  runId: string;
  agencyId: string;
  origin: string;
};
const log = createLogger({ service: 'perf', level: 'warn' });
const num = (v: string | undefined) => (v === undefined || v === '' ? null : Number(v));

/** A Kyero-like XML listing feed: safeFetch, XXE-safe streaming parse, mapped to the loader's `FeedListing`. */
const perfXml: imports.FeedConnector<XmlElement, FeedListingInput> = {
  key: 'perf-xml',
  fetch: (ctx) => imports.httpSource(ctx, { contentTypes: imports.XML_CONTENT_TYPES }),
  parse: (source) => imports.xmlRecords(source, { recordElement: 'property' }),
  map(raw) {
    const ref = childText(raw, 'ref');
    if (!ref) return { ok: false, problems: [{ code: 'MISSING_FIELD', field: 'ref' }] };
    const price = num(childText(raw, 'price'));
    const lat = num(childText(raw, 'lat'));
    const lng = num(childText(raw, 'lng'));
    return {
      ok: true,
      ref,
      item: {
        ref,
        transactionType: 'SALE',
        priceCents: price === null ? null : Math.round(price * 100),
        bedrooms: num(childText(raw, 'beds')),
        bathrooms: num(childText(raw, 'baths')),
        builtM2: num(childText(raw, 'built')),
        plotM2: num(childText(raw, 'plot')),
        energyRating: (childText(raw, 'energy') ?? null) as FeedListingInput['energyRating'],
        coordinates: lat !== null && lng !== null ? { lat, lng } : null,
        propertyType: childText(raw, 'type') ?? '',
        location: {
          country: childText(raw, 'country'),
          region: childText(raw, 'region'),
          city: childText(raw, 'city'),
          area: childText(raw, 'area'),
        },
        features: (childOf(raw, 'features')?.children ?? []).map((f) => f.text.trim()),
        translations: raw.children
          .filter((c) => c.name === 'desc')
          .map((d) => ({
            locale: d.attributes.lang ?? 'en',
            title: childText(d, 'title') ?? '',
            description: childText(d, 'text') ?? null,
          })),
        images: (childOf(raw, 'images')?.children ?? []).map((i) => i.text.trim()),
      },
    };
  },
  validate: () => [],
};

imports.configureImports({ keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }) });
imports.registerConnector(perfXml);
const undoLoopback = allowLoopbackOriginsForTests([origin]);

// After the imports and before the run: what the compiled process holds idle.
const base = process.memoryUsage().rss;
let peak = base;
const sampler = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss);
}, 50);
const started = performance.now();
try {
  const outcome = await imports.executeRun(
    { runId, agencyId },
    { log, signal: new AbortController().signal, lastAttempt: true },
    imports.listingSink,
  );
  const ms = performance.now() - started;
  clearInterval(sampler);
  peak = Math.max(peak, process.memoryUsage().rss);
  console.log(JSON.stringify({ base, peak, maxRss: process.resourceUsage().maxRSS * 1024, ms, outcome }));
} finally {
  clearInterval(sampler);
  undoLoopback();
  await closeDb();
  // keep-alive sockets of the feed fetch would hold the process open
  process.exit(0);
}
