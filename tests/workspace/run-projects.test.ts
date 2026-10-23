import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGroups, summary } from '../../scripts/ci/root-projects';

const ROOT = join(import.meta.dirname, '..', '..');
const GROUPS = ['infra,queue', 'adapters', 'apps', 'seed', 'ci', 'ops', 'golden'];

describe('root integration projects (S2-F3)', () => {
  it('[S2-F3] a planted failure in the queue project still runs and reports the other root projects', () => {
    const ran: string[][] = [];
    const results = runGroups(GROUPS, (projects) => {
      ran.push(projects);
      return { code: projects.includes('queue') ? 1 : 0 };
    });
    expect(ran).toEqual(GROUPS.map((g) => g.split(',')));
    expect(results.filter((r) => !r.ok).map((r) => r.group)).toEqual(['infra,queue']);
    expect(results.every((r) => r.ok)).toBe(false); // the script exits 1
    const text = summary(results);
    expect(text).toContain('FAIL infra,queue (exit 1)');
    for (const g of GROUPS.slice(1)) expect(text).toContain(`ok   ${g}`);
  });

  it('[S2-F3] a group that could not start (no exit code) counts as failed', () => {
    const [result] = runGroups(['ops'], () => ({ code: null, error: 'spawn pnpm ENOENT' }));
    expect(result).toEqual({ group: 'ops', ok: false, code: null, error: 'spawn pnpm ENOENT' });
    expect(summary([result as NonNullable<typeof result>])).toBe('FAIL ops (exit null): spawn pnpm ENOENT');
  });

  it('[S2-F3] test:int:root runs every root integration project through the runner', () => {
    const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>;
    expect(scripts['test:int:root']).toBe(`tsx scripts/ci/run-projects.ts ${GROUPS.join(' ')}`);
    const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');
    const intProjects = [
      ...config.matchAll(/name: '([a-z]+)',[^}]*?include: \['tests\/\1\/\*\*\/\*\.int\.test\.ts'\]/g),
    ]
      .map((m) => m[1])
      // perf and isolation have their own scripts (`test:perf:root`, `test:isolation`)
      .filter((p) => p !== 'perf' && p !== 'isolation');
    expect(new Set(intProjects)).toEqual(new Set(GROUPS.flatMap((g) => g.split(','))));
  });
});
