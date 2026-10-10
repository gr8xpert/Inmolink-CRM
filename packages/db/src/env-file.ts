import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * The workspace root (holds `pnpm-workspace.yaml`), searched upwards from the working directory —
 * this module may run bundled (Next.js server chunks), where its own path says nothing.
 */
function repoRoot(): string | undefined {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Local dev/test convenience: loads the repo env file for the stack (`.env` / `.env.test`, else —
 * for `db:migrate` and integration tests only — the committed example, which only points at localhost).
 *
 * All or nothing: if NODE_ENV is production or any DATABASE_URL_* is already set, nothing is
 * loaded, so real credentials are never mixed with example ones. App runtimes pass
 * `allowExample: false`: a container that lost its secrets must fail config validation, not boot
 * on example keys in development mode (S0-08 security audit).
 */
export function loadStackEnv(target: 'dev' | 'test', options: { allowExample?: boolean } = {}): void {
  if (process.env.NODE_ENV === 'production') return;
  if (Object.keys(process.env).some((k) => k.startsWith('DATABASE_URL_'))) return;
  const root = repoRoot();
  if (!root) return;
  const base = target === 'dev' ? '.env' : '.env.test';
  const candidates = [join(root, base)];
  if (options.allowExample !== false) candidates.push(join(root, `${base}.example`));
  const file = candidates.find((f) => existsSync(f));
  if (!file) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    if (process.env[key] === undefined && value !== undefined) process.env[key] = value;
  }
}
