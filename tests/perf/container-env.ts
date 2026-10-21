import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

/**
 * A worker container's memory settings from its deploy config (`infra/kamal/worker.yml`): RSS perf children run
 * with them, so V8 and glibc are sized as in the container, not by the CI runner (S5-CI, S6-F5).
 */
export function containerMemoryEnv(role: 'media' | 'workers'): {
  NODE_OPTIONS: string;
  MALLOC_MMAP_THRESHOLD_: string;
} {
  const worker = parse(readFileSync(new URL('../../infra/kamal/worker.yml', import.meta.url), 'utf8')) as {
    servers: Record<string, { env: { clear: Record<string, string> } }>;
  };
  const { NODE_OPTIONS, MALLOC_MMAP_THRESHOLD_ } = worker.servers[role]?.env.clear ?? {};
  if (!NODE_OPTIONS || !MALLOC_MMAP_THRESHOLD_) throw new Error(`worker.yml: the ${role} role sizes no memory`);
  return { NODE_OPTIONS, MALLOC_MMAP_THRESHOLD_ };
}
