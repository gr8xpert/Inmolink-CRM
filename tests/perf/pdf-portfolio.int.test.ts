import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpus, loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { WebsiteDetail, WebsitePresenter } from '@inmolink/contracts';
import { docFormat, portfolioHtml } from '@inmolink/core/modules/documents';
import { type Catalogs, translator } from '@inmolink/i18n/server';
import { createLogger } from '@inmolink/platform/logger';
import { createPuppeteerRenderer, type PdfRenderer } from '@inmolink/platform/pdf';
import { pdfPageCount } from '@inmolink/platform/pdf/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * S12-05 acceptance: a 20-page portfolio (a cover and 19 listings, each with a cover photo and three more) renders
 * in < 10 s — through the real adapter (Chrome via `PDF_CHROME_EXECUTABLE`, else the installed `chrome` channel; a
 * fresh browser context, JavaScript off, assets from the one allowed origin) and the real template. Images: 80
 * distinct URLs on a local server (a 480 × 320 photo-sized bitmap each, so every one is fetched and decoded). Timed
 * cold (browser launch included) and warm, three runs; the host's load is logged with the result.
 */

const log = createLogger({ service: 'perf', level: 'info' });
const LISTINGS = 19;
const BUDGET_MS = 10_000;

/** A 24-bit BMP of noise (a photo's worth of pixels to decode). */
function noiseBmp(width: number, height: number): Buffer {
  const row = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + row * height;
  const b = Buffer.alloc(size);
  b.write('BM', 0);
  b.writeUInt32LE(size, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(width, 18);
  b.writeInt32LE(height, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(row * height, 34);
  for (let i = 54; i < size; i++) b[i] = (i * 2654435761) >>> 24;
  return b;
}

const IMAGE = noiseBmp(480, 320);
let server: Server;
let origin = '';
let requests = 0;
let renderer: PdfRenderer;

const MESSAGES = fileURLToPath(new URL('../../packages/i18n/messages/', import.meta.url));
const catalogs: Catalogs = {
  en: { documents: JSON.parse(readFileSync(`${MESSAGES}en/documents.json`, 'utf8')) },
};

const presenter: WebsitePresenter = {
  name: 'Costa Homes',
  email: 'hello@costa.example',
  phone: '+34 600 000 000',
  whatsapp: null,
  website: 'https://costa.example',
  primaryColor: '#1f3a5f',
  accentColor: '#c8a45d',
};

const image = (n: number, cover: boolean) => ({
  kind: 'IMAGE' as const,
  cover,
  alt: null,
  room: null,
  width: 480,
  height: 320,
  urls: { large: `${origin}/img/${n}.bmp`, medium: `${origin}/img/${n}.bmp?m` },
});

function listing(i: number): WebsiteDetail {
  const text =
    'A bright family home with open views over the valley, a large terrace and a garden with mature trees. '.repeat(8);
  return {
    kind: 'LISTING',
    id: `0195f0a5-0001-7000-8000-${i.toString(16).padStart(12, '0')}`,
    ref: `CH-${1000 + i}`,
    status: 'ACTIVE',
    transactionType: 'SALE',
    price: { amountCents: 30_000_000 + i * 1_000_000, currency: 'EUR', period: null, onRequest: false },
    propertyType: { id: '0195f0a5-0001-7000-8000-0000000000a1', name: 'Villa', slug: 'villa' },
    place: {
      country: null,
      region: { id: '0195f0a5-0001-7000-8000-0000000000b1', name: 'Andalucía', slug: 'andalucia' },
      city: { id: '0195f0a5-0001-7000-8000-0000000000b2', name: 'Marbella', slug: 'marbella' },
      area: null,
    },
    bedrooms: 3 + (i % 3),
    bathrooms: 2,
    builtM2: 180 + i,
    plotM2: 800,
    geo: null,
    cover: image(i * 4, true),
    imageCount: 4,
    developmentId: null,
    developmentRef: null,
    title: `Villa ${i + 1} with sea views`,
    slug: `villa-${i}`,
    textLocale: null,
    description: text,
    metaTitle: null,
    metaDescription: null,
    terraceM2: 40,
    yearBuilt: 2010,
    priceToCents: null,
    communityFeeMonthCents: null,
    ibiYearCents: null,
    garbageTaxYearCents: null,
    energyRating: 'C',
    energyEmissionsRating: null,
    features: [],
    media: [image(i * 4, true), image(i * 4 + 1, false), image(i * 4 + 2, false), image(i * 4 + 3, false)],
    agency: presenter,
  } as WebsiteDetail;
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'image/bmp', 'content-length': IMAGE.length });
    res.end(IMAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  renderer = createPuppeteerRenderer({
    executablePath: process.env.PDF_CHROME_EXECUTABLE,
    allowedOrigins: [origin],
    concurrency: 2,
    timeoutMs: 30_000,
  });
});

afterAll(async () => {
  await renderer?.close();
  server?.close();
});

it('[S12-05] a 20-page portfolio renders in < 10 s (cold and warm)', async () => {
  const html = portfolioHtml({
    presenter,
    items: Array.from({ length: LISTINGS }, (_, i) => listing(i)),
    t: translator('en', 'documents', { catalogs }),
    format: docFormat('en'),
    asOf: new Date(),
    title: 'Perf portfolio',
  });
  const runs: { ms: number; pages: number; bytes: number; images: number }[] = [];
  for (let run = 0; run < 3; run++) {
    const before = requests;
    const started = performance.now();
    const bytes = await renderer.render(html);
    runs.push({
      ms: Math.round(performance.now() - started),
      pages: pdfPageCount(bytes),
      bytes: bytes.length,
      images: requests - before,
    });
  }
  log.info(
    { runs, cpus: cpus().length, loadavg: loadavg().map((x) => Math.round(x * 100) / 100), budgetMs: BUDGET_MS },
    '[S12-05] 20-page portfolio render',
  );
  for (const r of runs) {
    expect(r.pages).toBe(LISTINGS + 1);
    expect(r.images).toBeGreaterThanOrEqual(LISTINGS * 4);
    expect(r.ms).toBeLessThan(BUDGET_MS);
  }
}, 120_000);
