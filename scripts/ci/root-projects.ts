// Root integration projects runner (S2-F3), used by `scripts/ci/run-projects.ts` (`pnpm test:int:root`).
import { spawnSync } from 'node:child_process';

export type GroupResult = { group: string; ok: boolean; code: number | null; error?: string };
export type RunGroup = (projects: string[]) => { code: number | null; error?: string };

/** Runs every group with `run`, never stopping early; the results in order. */
export function runGroups(groups: readonly string[], run: RunGroup): GroupResult[] {
  return groups.map((group) => {
    const { code, error } = run(group.split(',').filter(Boolean));
    return { group, ok: code === 0, code, ...(error ? { error } : {}) };
  });
}

/** The summary printed after the last group (one line per group). */
export function summary(results: readonly GroupResult[]): string {
  return results
    .map((r) => {
      if (r.ok) return `ok   ${r.group}`;
      return `FAIL ${r.group} (exit ${r.code})${r.error ? `: ${r.error}` : ''}`;
    })
    .join('\n');
}

/** One `vitest run --project … --reporter=dot` for a group, output inherited. */
export const vitestGroup: RunGroup = (projects) => {
  const args = ['exec', 'vitest', 'run', ...projects.flatMap((p) => ['--project', p]), '--reporter=dot'];
  // `shell` so Windows resolves pnpm's `.cmd` shim; the arguments are fixed project names.
  const res = spawnSync('pnpm', args, { stdio: 'inherit', shell: process.platform === 'win32' });
  return { code: res.status, ...(res.error ? { error: res.error.message } : {}) };
};
