import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

const ROOT = join(import.meta.dirname, '..', '..', '..');

/**
 * Local dev/test convenience for `db:migrate` and integration tests: loads the repo env file for
 * the stack (`.env` / `.env.test`, else the committed example, which only points at localhost).
 *
 * All or nothing: if NODE_ENV is production or any DATABASE_URL_* is already set, nothing is
 * loaded, so real credentials are never mixed with example ones.
 */
export function loadStackEnv(target: 'dev' | 'test'): void {
  if (process.env.NODE_ENV === 'production') return;
  if (Object.keys(process.env).some((k) => k.startsWith('DATABASE_URL_'))) return;
  const base = target === 'dev' ? '.env' : '.env.test';
  const file = [join(ROOT, base), join(ROOT, `${base}.example`)].find((f) => existsSync(f));
  if (!file) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    if (process.env[key] === undefined && value !== undefined) process.env[key] = value;
  }
}
