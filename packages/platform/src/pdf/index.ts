import puppeteer, { type Browser, type HTTPRequest } from 'puppeteer-core';
import { z } from 'zod';
import { loadConfig } from '../config';
import type { Logger } from '../logger';

/**
 * `@inmolink/platform/pdf` — HTML → PDF (S12-05, PLAN §7 M13): brochures, portfolios, accepted viewing terms. Runs in
 * the `pdf` worker pool only (a browser per process, `concurrency` pages at a time).
 *
 * Rendered pages are untrusted-content sinks (listing texts, agency branding), so every render:
 * - gets its own browser context (no cookies, storage or cache shared with another render) and is closed after;
 * - runs with JavaScript off (templates are static HTML and CSS), no remote fonts, no GPU;
 * - may load nothing but `data:image/(png|jpeg|webp)` URLs and our own asset origins (`allowedOrigins`, e.g. the media
 *   CDN). Three walls: request interception refuses every other URL (redirects included); every request goes to a
 *   dead proxy (`--proxy-server=127.0.0.1:9`) except to the allowed hosts (`--proxy-bypass-list`, loopback not
 *   implicitly bypassed: `<-loopback>`), which covers IP literals (`169.254.169.254`, `127.0.0.1:9222`) as well as
 *   names; and Chrome's host resolver resolves no other name (`--host-resolver-rules`);
 * - loads at most `maxAssets` requests and `maxAssetBytes` bytes over the network (past the bytes the render fails);
 * - runs in Chrome's sandbox. `noSandbox` (`PDF_CHROME_NO_SANDBOX`) must never be set unless the container itself is
 *   the sandbox (seccomp, no privileges, read-only root, egress to the CDN only) — S12-05 deploy notes;
 * - is bounded by `timeoutMs` (content load and print) and the caller's signal.
 *
 * Chrome comes from a configured executable (`PDF_CHROME_EXECUTABLE`) or an installed channel (`PDF_CHROME_CHANNEL`,
 * default `chrome`); `puppeteer-core` never downloads a browser. After `rendersPerBrowser` renders the browser is
 * retired (memory): new renders start on a fresh browser and the old one closes once its last page is done, so
 * recycling happens under steady load too. A crashed browser is replaced on the next render.
 */

export interface PdfRenderOptions {
  signal?: AbortSignal;
}

export interface PdfRenderer {
  /** The PDF of a complete HTML document (A4 unless its CSS `@page` says otherwise). */
  render(html: string, options?: PdfRenderOptions): Promise<Uint8Array>;
  /** Renders running in this process now. */
  readonly active: number;
  close(): Promise<void>;
}

export type ChromeChannel = 'chrome' | 'chrome-beta' | 'chrome-dev' | 'chrome-canary';

export interface PuppeteerRendererOptions {
  /** A Chrome / Chromium binary; without it, the installed `channel`. */
  executablePath?: string;
  channel?: ChromeChannel;
  /** Origins rendered pages may load assets from (`https://media.inmolink.es`). Everything else is refused. */
  allowedOrigins: readonly string[];
  /** Pages rendering at once in this process. */
  concurrency: number;
  timeoutMs: number;
  /** Never without an outer sandbox (see above). Default false. */
  noSandbox?: boolean;
  /** Retire the browser after this many renders. Default 200. */
  rendersPerBrowser?: number;
  /** Requests one render may make (more are refused). Default 600. */
  maxAssets?: number;
  /** Bytes one render may load over the network (past it the render fails). Default 80 MB. */
  maxAssetBytes?: number;
  /** Tests only: `false` turns request interception off, to prove the proxy and resolver walls on their own. */
  requestInterception?: boolean;
  logger?: Logger;
}

const DATA_IMAGE = /^data:image\/(png|jpeg|webp)[;,]/i;
const OTHER_SCHEMES = /^(data|blob|file|filesystem|javascript|ftp|ws|wss):/i;

/**
 * Whether a rendered page may load `url`: `about:blank`, an image `data:` URL (PNG, JPEG, WebP), or one of the allowed
 * origins (exact origin: scheme, host and port).
 */
export function pdfAssetAllowed(url: string, allowedOrigins: ReadonlySet<string>): boolean {
  if (url === 'about:blank' || DATA_IMAGE.test(url)) return true;
  if (OTHER_SCHEMES.test(url)) return false;
  try {
    return allowedOrigins.has(new URL(url).origin);
  } catch {
    return false;
  }
}

function normalizedOrigins(origins: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const o of origins) {
    const u = new URL(o);
    if (u.protocol !== 'https:' && u.protocol !== 'http:')
      throw new TypeError(`pdf: asset origin must be http(s): ${o}`);
    out.add(u.origin);
  }
  return out;
}

/** Chrome flags: the three network walls, no extensions or background traffic, no GPU, no remote fonts. */
export function chromeArgs(origins: ReadonlySet<string>, noSandbox: boolean): string[] {
  const hosts = [...new Set([...origins].map((o) => new URL(o).hostname))];
  const resolver = ['MAP * ~NOTFOUND', ...hosts.map((h) => `EXCLUDE ${h}`)].join(', ');
  return [
    // A dead proxy for everything but our hosts — IP literals included (the resolver rules see names only).
    '--proxy-server=http://127.0.0.1:9',
    `--proxy-bypass-list=${['<-loopback>', ...hosts].join(';')}`,
    `--host-resolver-rules=${resolver}`,
    '--disable-gpu',
    '--disable-remote-fonts',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--hide-scrollbars',
    // `--no-zygote` is only allowed without the sandbox.
    ...(noSandbox ? ['--no-sandbox', '--no-zygote'] : []),
  ];
}

class Slots {
  private waiting: (() => void)[] = [];
  active = 0;
  constructor(private readonly max: number) {}
  async acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const go = () => {
        signal?.removeEventListener('abort', abort);
        this.active++;
        resolve();
      };
      const abort = () => {
        this.waiting = this.waiting.filter((w) => w !== go);
        reject(signal?.reason ?? new Error('aborted'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.waiting.push(go);
    });
  }
  release(): void {
    this.active--;
    this.waiting.shift()?.();
  }
}

/** One launched browser: its renders so far and pages in flight. */
interface Generation {
  browser: Promise<Browser>;
  renders: number;
  inFlight: number;
  retired: boolean;
}

export function createPuppeteerRenderer(options: PuppeteerRendererOptions): PdfRenderer & {
  /** Browsers launched by this renderer that are still open (tests: recycling). */
  readonly browsers: number;
  readonly launches: number;
} {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new TypeError('pdf: concurrency ≥ 1');
  const origins = normalizedOrigins(options.allowedOrigins);
  const args = chromeArgs(origins, options.noSandbox === true);
  const perBrowser = options.rendersPerBrowser ?? 200;
  const maxAssets = options.maxAssets ?? 600;
  const maxAssetBytes = options.maxAssetBytes ?? 80 * 1024 * 1024;
  const slots = new Slots(options.concurrency);
  let current: Generation | null = null;
  const all = new Set<Generation>();
  let launches = 0;
  let closed = false;

  const closeGeneration = (g: Generation) => {
    all.delete(g);
    void g.browser.then((b) => b.close()).catch(() => undefined);
  };

  const launch = (): Generation => {
    launches++;
    const g: Generation = {
      browser: Promise.resolve(null as unknown as Browser),
      renders: 0,
      inFlight: 0,
      retired: false,
    };
    g.browser = puppeteer
      .launch({
        headless: true,
        args,
        ...(options.executablePath
          ? { executablePath: options.executablePath }
          : { channel: options.channel ?? 'chrome' }),
        // The browser exits with the worker; its signals are the worker's.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      })
      .then((b) => {
        b.on('disconnected', () => {
          if (current === g) current = null;
          all.delete(g);
        });
        return b;
      });
    g.browser.catch(() => {
      if (current === g) current = null;
      all.delete(g);
    });
    all.add(g);
    return g;
  };

  /** The browser for the next render; a browser past `rendersPerBrowser` is retired (closed once drained). */
  const take = (): Generation => {
    if (closed) throw new Error('pdf: renderer closed');
    if (current && current.renders >= perBrowser) {
      const old = current;
      old.retired = true;
      current = null;
      if (old.inFlight === 0) closeGeneration(old);
    }
    current ??= launch();
    current.renders++;
    current.inFlight++;
    return current;
  };

  const give = (g: Generation) => {
    g.inFlight--;
    if (g.retired && g.inFlight === 0) closeGeneration(g);
  };

  return {
    get active() {
      return slots.active;
    },
    get browsers() {
      return all.size;
    },
    get launches() {
      return launches;
    },

    async render(html, renderOptions = {}) {
      const { signal } = renderOptions;
      await slots.acquire(signal);
      let g: Generation | undefined;
      try {
        g = take();
        const b = await g.browser;
        const context = await b.createBrowserContext();
        let failure: Error | null = null;
        const stop = (err: Error) => {
          failure ??= err;
          void context.close().catch(() => undefined);
        };
        const onAbort = () => stop(new Error('pdf: render aborted'));
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          const page = await context.newPage();
          await page.setJavaScriptEnabled(false);
          // Bytes over the network, as they arrive (a response without Content-Length counts too).
          let bytes = 0;
          const cdp = await page.createCDPSession();
          await cdp.send('Network.enable');
          cdp.on('Network.dataReceived', (e: { encodedDataLength: number; dataLength: number }) => {
            bytes += Math.max(e.encodedDataLength, e.dataLength);
            if (bytes > maxAssetBytes) stop(new Error(`pdf: assets over ${maxAssetBytes} bytes`));
          });
          let requests = 0;
          const intercept = options.requestInterception !== false;
          if (intercept) await page.setRequestInterception(true);
          page.on('request', (req: HTTPRequest) => {
            if (!intercept) return;
            if (req.isInterceptResolutionHandled()) return;
            const url = req.url();
            if (!url.startsWith('data:') && url !== 'about:blank') requests++;
            if (pdfAssetAllowed(url, origins) && requests <= maxAssets) void req.continue();
            else {
              options.logger?.debug({ host: safeHost(url), requests }, 'pdf: asset refused');
              void req.abort('blockedbyclient');
            }
          });
          await page.setContent(html, { waitUntil: 'load', timeout: options.timeoutMs });
          if (failure) throw failure;
          signal?.throwIfAborted();
          const pdfBytes = await page.pdf({
            format: 'A4',
            printBackground: true,
            preferCSSPageSize: true,
            timeout: options.timeoutMs,
          });
          if (failure) throw failure;
          return new Uint8Array(pdfBytes);
        } catch (err) {
          throw failure ?? err;
        } finally {
          signal?.removeEventListener('abort', onAbort);
          await context.close().catch(() => undefined);
        }
      } finally {
        if (g) give(g);
        slots.release();
      }
    },

    async close() {
      closed = true;
      current = null;
      await Promise.all([...all].map((g) => g.browser.then((b) => b.close()).catch(() => undefined)));
      all.clear();
    },
  };
}

const safeHost = (url: string): string => {
  try {
    return new URL(url).host.slice(0, 100);
  } catch {
    return '(invalid)';
  }
};

/** `pdf` pool settings (env). */
export const pdfEnv = {
  /** A Chrome / Chromium binary (production image: the distribution's Chromium). Unset: `PDF_CHROME_CHANNEL`. */
  PDF_CHROME_EXECUTABLE: z.string().trim().min(1).optional(),
  PDF_CHROME_CHANNEL: z.enum(['chrome', 'chrome-beta', 'chrome-dev', 'chrome-canary']).default('chrome'),
  /** Pages rendering at once per worker process (each page holds a few hundred MB at worst). */
  PDF_RENDER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  PDF_RENDER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  /**
   * `true` drops Chrome's sandbox. Never set it unless the container itself is the sandbox (seccomp, no privileges,
   * read-only root, egress to the CDN only) — S12-05 deploy notes.
   */
  PDF_CHROME_NO_SANDBOX: z.enum(['true', 'false']).default('false'),
};

export function createPdfRendererFromEnv(options: {
  allowedOrigins: readonly string[];
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
}): PdfRenderer {
  const c = loadConfig(pdfEnv, options.env ?? process.env);
  return createPuppeteerRenderer({
    executablePath: c.PDF_CHROME_EXECUTABLE,
    channel: c.PDF_CHROME_CHANNEL,
    allowedOrigins: options.allowedOrigins,
    concurrency: c.PDF_RENDER_CONCURRENCY,
    timeoutMs: c.PDF_RENDER_TIMEOUT_MS,
    noSandbox: c.PDF_CHROME_NO_SANDBOX === 'true',
    logger: options.logger,
  });
}

let installed: PdfRenderer | undefined;

/** Installs the process renderer (the `pdf` pool at boot); `undefined` removes it (tests). */
export function configurePdf(renderer: PdfRenderer | undefined): void {
  installed = renderer;
}

/** The process renderer. */
export function pdf(): PdfRenderer {
  if (!installed) throw new Error('pdf: no renderer configured (the pdf worker pool configures one at boot)');
  return installed;
}

/** Graceful shutdown. */
export async function closePdf(): Promise<void> {
  const r = installed;
  installed = undefined;
  await r?.close();
}
