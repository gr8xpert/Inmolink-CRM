// The built worker image can render PDFs (S17-F53): run inside it, from packages/platform, under the `pdf` role's
// container options (see the `Smoke (browser ...)` step in .github/workflows/ci.yml). Fails unless the browser starts,
// Chrome reports its sandbox in effect, the adapter's network walls hold on this Chromium, and a Spanish page renders
// with the font the templates resolve to. Piped in over stdin: the image holds no scripts/.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer-core';
import { chromeArgs, createPuppeteerRenderer } from './dist/pdf/index.js';

const executablePath = '/usr/bin/chromium';
const fail = (message) => {
  console.error(`pdf smoke: ${message}`);
  process.exit(1);
};

const font = execFileSync('fc-match', ['Arial'], { encoding: 'utf8' });
if (!font.includes('Liberation Sans')) fail(`Arial resolves to ${font.trim()}`);

// 1. Chrome's own account of its sandbox. No --no-sandbox: the adapter's flags as production runs them.
const allowed = new Set(['https://media.inmolink.es']);
const browser = await puppeteer.launch({ headless: true, executablePath, args: chromeArgs(allowed, false) });
console.log(`pdf smoke: ${await browser.version()}`);
const page = await browser.newPage();
await page.goto('chrome://sandbox');
await page.waitForFunction(() => document.body.innerText.includes('sandboxed'), { timeout: 10_000 });
const status = await page.evaluate(() => document.body.innerText);
await browser.close();
console.log(status);
for (const line of [/Layer 1 Sandbox\s+Namespace/, /Seccomp-BPF sandbox\s+Yes/, /You are adequately sandboxed/]) {
  if (!line.test(status)) fail(`sandbox status lacks ${line}`);
}

// 2. The network walls on this Chromium, interception off (flags alone): the allowed host loads, nothing else does.
const hits = { allowed: 0, refused: 0 };
const listen = (kind) =>
  new Promise((resolve) => {
    const server = createServer((_req, res) => {
      hits[kind]++;
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
const allowedPort = await listen('allowed');
const refusedPort = await listen('refused');
const renderer = createPuppeteerRenderer({
  executablePath,
  allowedOrigins: [`http://127.0.0.1:${allowedPort}`],
  concurrency: 1,
  timeoutMs: 30_000,
  requestInterception: false,
});
const walls = `<!doctype html><img src="http://127.0.0.1:${allowedPort}/a.png"><img src="http://localhost:${refusedPort}/b.png"><img src="http://[::1]:${refusedPort}/c.png"><img src="http://169.254.169.254/d.png">`;
await renderer.render(walls);
if (hits.allowed === 0) fail('the allowed origin was not loaded');
if (hits.refused > 0) fail('a request got past the walls');

// 3. A real page: Spanish characters, in the expected font.
const pdf = await renderer.render(
  '<!doctype html><meta charset="utf-8"><body style="font-family: Helvetica, Arial, sans-serif">Año, señor, ¿cuánto? ¡Sí! Á É Í Ó Ú Ñ Ü € m²',
);
await renderer.close();
const text = Buffer.from(pdf).toString('latin1');
if (!text.startsWith('%PDF-')) fail('not a PDF');
if (!/LiberationSans/.test(text)) fail('the PDF does not embed Liberation Sans');
console.log(`pdf smoke: ok, ${pdf.length} bytes`);
process.exit(0);
