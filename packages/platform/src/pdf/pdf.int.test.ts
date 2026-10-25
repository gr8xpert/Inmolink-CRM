import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPuppeteerRenderer, type PdfRenderer, pdfAssetAllowed } from './index';
import { pdfPageCount } from './testing';

/**
 * The Puppeteer adapter against a real Chrome (S12-05): `PDF_CHROME_EXECUTABLE`, else the installed `chrome` channel
 * (CI runners and dev machines have one). Two local servers: one an allowed asset origin, the other not.
 */

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function server(): Promise<{ server: Server; origin: string; hits: string[] }> {
  const hits: string[] = [];
  const s = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG_1PX);
  });
  return new Promise((resolve) =>
    s.listen(0, '127.0.0.1', () =>
      resolve({ server: s, origin: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, hits }),
    ),
  );
}

let allowed: Awaited<ReturnType<typeof server>>;
let refused: Awaited<ReturnType<typeof server>>;
let renderer: PdfRenderer;

beforeAll(async () => {
  allowed = await server();
  refused = await server();
  renderer = createPuppeteerRenderer({
    executablePath: process.env.PDF_CHROME_EXECUTABLE,
    allowedOrigins: [allowed.origin],
    concurrency: 2,
    timeoutMs: 20_000,
  });
}, 60_000);

afterAll(async () => {
  await renderer?.close();
  allowed?.server.close();
  refused?.server.close();
});

const page = (body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:0}.p{page-break-after:always;height:100px}</style></head><body>${body}</body></html>`;

describe('PDF adapter (S12-05)', () => {
  it('[S12-05] renders HTML to a PDF; pages may load only the allowed asset origins and run no script', async () => {
    const bytes = await renderer.render(
      page(
        `<div class="p"><img src="${allowed.origin}/ok.png"></div>` +
          `<div class="p"><img src="${refused.origin}/leak.png"><img src="https://example.com/x.png"></div>` +
          `<div class="p"><script>new Image().src = '${allowed.origin}/from-script.png'</script>3</div>`,
      ),
    );
    expect(new TextDecoder('latin1').decode(bytes.slice(0, 5))).toBe('%PDF-');
    expect(pdfPageCount(bytes)).toBe(3);
    expect(allowed.hits).toEqual(['/ok.png']);
    expect(refused.hits).toEqual([]);
  }, 60_000);

  it('[S12-05] renders at most `concurrency` pages at once per process', async () => {
    let max = 0;
    const poll = setInterval(() => {
      max = Math.max(max, renderer.active);
    }, 5);
    try {
      const all = await Promise.all(
        Array.from({ length: 5 }, (_, i) => renderer.render(page(`<div class="p">${i}</div>`))),
      );
      expect(all.every((b) => pdfPageCount(b) === 1)).toBe(true);
    } finally {
      clearInterval(poll);
    }
    expect(max).toBe(2);
    expect(renderer.active).toBe(0);
  }, 60_000);

  it('[S12-05] asset check: exact origins only', () => {
    const set = new Set(['https://media.inmolink.es']);
    expect(pdfAssetAllowed('https://media.inmolink.es/a/b.webp', set)).toBe(true);
    expect(pdfAssetAllowed('data:image/png;base64,AAAA', set)).toBe(true);
    expect(pdfAssetAllowed('https://media.inmolink.es.evil.com/a', set)).toBe(false);
    expect(pdfAssetAllowed('http://media.inmolink.es/a', set)).toBe(false);
    expect(pdfAssetAllowed('file:///etc/passwd', set)).toBe(false);
    expect(pdfAssetAllowed('http://169.254.169.254/latest', set)).toBe(false);
  });
});
