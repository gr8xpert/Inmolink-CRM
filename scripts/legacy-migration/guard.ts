// Production guard of the legacy migration operator scripts (S14 review): `legacy:load`, `legacy:cutover`,
// `legacy:delta`, `legacy:validate` and `legacy:developments` write a whole agency's data, so they must never run
// against a database the operator did not name.
//
// - `--test` (the local test stack) is refused when real credentials are in the environment (any `DATABASE_URL_*`) or
//   NODE_ENV is production: a test run never reaches a real database.
// - Every other run needs `--target <database host>`: the host of every `DATABASE_URL_*` (the stack's env file
//   locally, the real credentials elsewhere) must be that host. The host is printed; a mismatch refuses the run.
import { readStackEnv, type StackTarget } from '../ops/stack-env';

export class TargetGuardError extends Error {
  override name = 'TargetGuardError';
}

export interface TargetGuardInput {
  /** `--test`. */
  test: boolean;
  /** `--target <host>` (optional `:port`). */
  target?: string | undefined;
  env: Readonly<Record<string, string | undefined>>;
}

const dbUrlKeys = (env: TargetGuardInput['env']) =>
  Object.keys(env)
    .filter((k) => k.startsWith('DATABASE_URL_') && env[k])
    .sort();

function hostOf(url: string): { host: string; port: string } | null {
  try {
    const u = new URL(url);
    return u.hostname ? { host: u.hostname.toLowerCase(), port: u.port } : null;
  } catch {
    return null;
  }
}

/** Refuses `--test` next to real credentials or in production (before the stack's env file is read). */
export function assertTestRunIsLocal(input: Omit<TargetGuardInput, 'target'>): void {
  if (!input.test) return;
  const keys = dbUrlKeys(input.env);
  if (input.env.NODE_ENV === 'production' || keys.length > 0) {
    throw new TargetGuardError(
      `--test refused: ${input.env.NODE_ENV === 'production' ? 'NODE_ENV is production' : `${keys[0]} is set`} ` +
        '(a test run uses the local test stack only)',
    );
  }
}

/**
 * The database host every `DATABASE_URL_*` names, checked against `--target` (not needed for `--test`, which runs on the
 * local test stack; call `assertTestRunIsLocal` first, before the stack's env file is read). Throws `TargetGuardError` when the target is missing, a URL has no host, or the hosts differ.
 */
export function assertTargetDatabase(input: TargetGuardInput): string {
  // `--test` was checked by `assertTestRunIsLocal` before the stack's env file filled DATABASE_URL_*.
  const keys = dbUrlKeys(input.env);
  if (keys.length === 0) throw new TargetGuardError('no DATABASE_URL_* is set: nothing to connect to');
  const hosts = new Map<string, string>();
  for (const k of keys) {
    const h = hostOf(input.env[k] as string);
    if (!h) throw new TargetGuardError(`${k} names no database host`);
    hosts.set(k, h.port ? `${h.host}:${h.port}` : h.host);
  }
  const names = [...new Set([...hosts.values()].map((h) => h.replace(/:\d+$/, '')))];
  if (input.test) return names.join(', ');
  if (!input.target?.trim()) {
    throw new TargetGuardError(
      `--target <database host> is required (this run would write to ${names.join(', ')}); pass --test for the local test stack`,
    );
  }
  const want = hostOf(`postgres://${input.target.trim()}`);
  if (!want) throw new TargetGuardError(`--target ${JSON.stringify(input.target)} is not a host`);
  for (const [k, h] of hosts) {
    const [host, port = ''] = h.split(/:(?=\d+$)/);
    if (host !== want.host || (want.port !== '' && port !== want.port)) {
      throw new TargetGuardError(`refused: --target is ${input.target.trim()}, but ${k} points at ${h}`);
    }
  }
  return want.host;
}

/**
 * The scripts' preamble: refuses `--test` next to real credentials, reads the local stack's env file when no
 * credentials are set (dev, or the test stack with `--test`), then checks `--target` and prints the database host.
 * Exits 1 with the reason on a refusal.
 */
export function prepareLegacyScriptEnv(
  opts: { test: boolean; target?: string | undefined; script: string },
  env: NodeJS.ProcessEnv = process.env,
  readStack: (t: StackTarget) => Readonly<Record<string, string | undefined>> = readStackEnv,
): string {
  try {
    assertTestRunIsLocal({ test: opts.test, env });
    if (env.NODE_ENV !== 'production' && dbUrlKeys(env).length === 0) {
      for (const [k, v] of Object.entries(readStack(opts.test ? 'test' : 'dev'))) env[k] ??= v;
    }
    const host = assertTargetDatabase({ test: opts.test, target: opts.target, env });
    process.stderr.write(`${opts.script}: database host ${host}${opts.test ? ' (test stack)' : ''}\n`);
    return host;
  } catch (err) {
    if (!(err instanceof TargetGuardError)) throw err;
    process.stderr.write(`${opts.script}: ${err.message}\n`);
    process.exit(1);
  }
}
