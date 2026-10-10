import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = join(import.meta.dirname, '..', '..');

interface Step {
  name?: string;
  run?: string;
  uses?: string;
}
interface Job {
  name?: string;
  if?: string;
  needs?: string[];
  steps: Step[];
  strategy?: { matrix?: { app?: string[] } };
}
interface Workflow {
  on: { pull_request?: { branches?: string[] }; push?: { branches?: string[] } };
  jobs: Record<string, Job>;
}

const workflow = parse(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')) as Workflow;
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
const runs = (job: Job) => job.steps.map((s) => s.run ?? '').join('\n');
const allRuns = Object.values(workflow.jobs).map(runs).join('\n');

describe('CI workflow', () => {
  it('[S0-14] runs on pull requests to main and on pushes to main', () => {
    expect(workflow.on.pull_request?.branches).toEqual(['main']);
    expect(workflow.on.push?.branches).toEqual(['main']);
  });

  it('[S0-14] a failing isolation or boundary check blocks merge: both feed the required job, which fails unless all succeed', () => {
    expect(runs(workflow.jobs.isolation as Job)).toContain('pnpm test:isolation');
    const boundaries = runs(workflow.jobs.boundaries as Job);
    expect(boundaries).toContain('pnpm check:boundaries');
    expect(boundaries).toContain('pnpm test:boundaries');

    const required = workflow.jobs.required as Job;
    expect(required.if).toBe('always()'); // still reports (as failed) when a needed job failed or was skipped
    expect(required.needs).toEqual(expect.arrayContaining(['isolation', 'boundaries']));
    // Every job except the post-merge image builds is required.
    const others = Object.keys(workflow.jobs).filter((j) => !['required', 'images', 'image-postgres'].includes(j));
    expect([...(required.needs ?? [])].sort()).toEqual(others.sort());
    expect(runs(required)).toMatch(/\[ "\$r" = success \] \|\| exit 1/);
  });

  it('[S0-14] covers every task of pnpm verify, plus i18n, build and the migration check', () => {
    const verifyTasks = rootPkg.scripts.verify?.replace('turbo run ', '').replace('--affected', '').trim().split(/\s+/);
    expect(verifyTasks?.length).toBeGreaterThan(5);
    for (const task of verifyTasks ?? []) {
      const ran = new RegExp(`(turbo run [^\\n]*\\b${task}(?=\\s|$)|pnpm ${task}(?=\\s|$))`, 'm').test(allRuns);
      expect(ran, `verify task "${task}" is not run in CI`).toBe(true);
    }
    expect(allRuns).toContain('pnpm i18n:check');
    expect(allRuns).toMatch(/turbo run [^\n]*\bbuild\b/);
    expect(allRuns).toContain('pnpm db:generate');
    expect(allRuns).toContain('pnpm ci:migrations');
  });

  it('[S0-14] pins every external action to a full commit SHA (the image job can write packages)', () => {
    const files = [
      join(ROOT, '.github', 'workflows', 'ci.yml'),
      join(ROOT, '.github', 'workflows', 'restore-drill.yml'),
      join(ROOT, '.github', 'actions', 'setup', 'action.yml'),
    ];
    const uses = files.flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/uses:\s*(\S+)/g)].map((m) => m[1] as string),
    );
    const external = uses.filter((u) => !u.startsWith('./'));
    expect(external.length).toBeGreaterThan(5);
    for (const u of external) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it('[S0-14] builds one image per deployable app, only on main', () => {
    const images = workflow.jobs.images as Job;
    expect(images.if).toContain("github.ref == 'refs/heads/main'");
    expect(images.needs).toEqual(['required']);
    const apps = readdirSync(join(ROOT, 'apps'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'wp-plugin')
      .map((d) => d.name);
    expect([...(images.strategy?.matrix?.app ?? [])].sort()).toEqual(apps.sort());
    // An image whose production install cannot resolve its imports never reaches the registry.
    const names = images.steps.map((s) => s.name ?? '');
    const smoke = names.findIndex((n) => n.startsWith('Smoke'));
    expect(smoke).toBeGreaterThan(names.indexOf('Build'));
    expect(smoke).toBeLessThan(names.indexOf('Push'));
  });
});
