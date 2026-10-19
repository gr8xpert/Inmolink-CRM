import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

/** The test stack's env (`.env.test`, else the committed example), passed explicitly to every app. */
export const ROOT = join(import.meta.dirname, '..', '..');

export function testStackEnv(): Record<string, string> {
  const file = [join(ROOT, '.env.test'), join(ROOT, '.env.test.example')].find((f) => existsSync(f));
  if (!file) throw new Error('no .env.test(.example)');
  const env = parseEnv(readFileSync(file, 'utf8'));
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
}

const env = testStackEnv();
const port = (url: string | undefined, name: string) => {
  if (!url) throw new Error(`${name} is not set in the test env`);
  return Number(new URL(url).port);
};

/** Ports come from WEB_URL / API_URL so links in emails and server-side API calls line up. */
export const PORTS = {
  web: port(env.WEB_URL, 'WEB_URL'),
  api: port(env.API_URL, 'API_URL'),
  workerHealth: 54_112,
  /** Lighthouse talks to its own Chromium over the DevTools protocol (S1-10). */
  devtools: 54_113,
  /** The fixture feed host the generic XML import reads (S6-04). */
  feed: 54_114,
};

export const MAILPIT_URL = env.MAILPIT_URL ?? 'http://localhost:58025';
