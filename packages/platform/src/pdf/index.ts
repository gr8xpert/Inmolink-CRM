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
 * - runs with JavaScript off (templates are static HTML and CSS);
 * - may load nothing but `data:` URLs and our own asset origins (`allowedOrigins`, e.g. the media CDN): every other
 *   request, redirects included, is refused by request interception, and Chrome's host resolver maps every other
 *   host to nothing (`--host-resolver-rules`) as a second wall;
 * - runs in Chrome's sandbox (`noSandbox` only where the container cannot provide one — S12-05 deploy notes);
 * - is bounded by `timeoutMs` (content load and print) and the caller's signal.
 *
 * Chrome comes from a configured executable (`PDF_CHROME_EXECUTABLE`) or an installed channel (`PDF_CHROME_CHANNEL`,
 * default `chrome`); `puppeteer-core` never downloads a browser. The browser is relaunched after `rendersPerBrowser`
 * renders (memory) and after a crash.
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
  /** Only where the container cannot run Chrome's sandbox (S12-05 deploy notes). Default false. */
  noSandbox?: boolean;
  /** Relaunch the browser after this many renders. Default 200. */
  rendersPerBrowser?: number;
  logger?: Logger;
}

const DATA_URL = /^data:/i;

/** Whether a rendered page may load `url`: `data:` and `about:blank`, or one of the allowed origins (exact origin). */
export function pdfAssetAllowed(url: string, allowedOrigins: ReadonlySet<string>): boolean {
  if (DATA_URL.test(url) || url === 'about:blank') return true;
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

/** Chrome flags: no extensions, no background traffic, nothing but our hosts resolvable. */
function chromeArgs(origins: ReadonlySet<string>, noSandbox: boolean): string[] {
  const hosts = [...origins].map((o) => new URL(o).hostname);
  const resolver = ['MAP * ~NOTFOUND', ...hosts.map((h) => `EXCLUDE ${h}`)].join(', ');
  return [
    `--host-resolver-rules=${resolver}`,
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
    ...(noSandbox ? ['--no-sandbox'] : []),
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

export function createPuppeteerRenderer(options: PuppeteerRendererOptions): PdfRenderer {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new TypeError('pdf: concurrency ≥ 1');
  const origins = normalizedOrigins(options.allowedOrigins);
  const args = chromeArgs(origins, options.noSandbox === true);
  const perBrowser = options.rendersPerBrowser ?? 200;
  const slots = new Slots(options.concurrency);
  let browser: Promise<Browser> | null = null;
  let renders = 0;
  let closed = false;

  const launch = (): Promise<Browser> => {
    const started = puppeteer
      .launch({
        headless: true,
        args,
        ...(options.executablePath
          ? { executablePath: options.executablePath }
          : { channel: options.channel ?? 'chrome' }),
        // No proxy or extension can be configured from outside; the browser exits with the worker.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      })
      .then((b) => {
        b.on('disconnected', () => {
          if (browser === started) browser = null;
        });
        return b;
      });
    started.catch(() => {
      if (browser === started) browser = null;
    });
    return started;
  };

  const current = async (): Promise<Browser> => {
    if (closed) throw new Error('pdf: renderer closed');
    // Recycle between renders only: a browser with pages in flight finishes them.
    if (browser && renders >= perBrowser && slots.active <= 1) {
      const old = browser;
      browser = null;
      renders = 0;
      void old.then((b) => b.close()).catch(() => undefined);
    }
    browser ??= launch();
    return browser;
  };

  return {
    get active() {
      return slots.active;
    },

    async render(html, renderOptions = {}) {
      const { signal } = renderOptions;
      await slots.acquire(signal);
      try {
        const b = await current();
        renders++;
        const context = await b.createBrowserContext();
        const onAbort = () => void context.close().catch(() => undefined);
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          const page = await context.newPage();
          await page.setJavaScriptEnabled(false);
          await page.setRequestInterception(true);
          page.on('request', (req: HTTPRequest) => {
            if (req.isInterceptResolutionHandled()) return;
            if (pdfAssetAllowed(req.url(), origins)) void req.continue();
            else {
              options.logger?.debug({ host: safeHost(req.url()) }, 'pdf: asset refused');
              void req.abort('blockedbyclient');
            }
          });
          await page.setContent(html, { waitUntil: 'load', timeout: options.timeoutMs });
          signal?.throwIfAborted();
          const bytes = await page.pdf({
            format: 'A4',
            printBackground: true,
            preferCSSPageSize: true,
            timeout: options.timeoutMs,
          });
          return new Uint8Array(bytes);
        } finally {
          signal?.removeEventListener('abort', onAbort);
          await context.close().catch(() => undefined);
        }
      } finally {
        slots.release();
      }
    },

    async close() {
      closed = true;
      const b = browser;
      browser = null;
      if (b) await b.then((x) => x.close()).catch(() => undefined);
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
  /** Only for a container that cannot give Chrome its sandbox (S12-05 deploy notes): `true` drops it. */
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
