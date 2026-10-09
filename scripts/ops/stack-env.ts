import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export type StackTarget = 'dev' | 'test';
export type StackEnv = Readonly<Record<string, string | undefined>>;

const ROOT = join(import.meta.dirname, '..', '..');

/** Env file for a compose profile: the developer's own copy wins, the committed example is the fallback. */
export function stackEnvFile(target: StackTarget): string {
  const base = target === 'dev' ? '.env' : '.env.test';
  const own = join(ROOT, base);
  return existsSync(own) ? own : join(ROOT, `${base}.example`);
}

/** Parses the target's env file without touching process.env, so dev and test values never mix. */
export function readStackEnv(target: StackTarget): StackEnv {
  return parseEnv(readFileSync(stackEnvFile(target), 'utf8'));
}
