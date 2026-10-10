import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const ADR_DIR = join(ROOT, 'docs', 'adr');
const read = (path: string) => readFileSync(path, 'utf8');

const adrFiles = readdirSync(ADR_DIR).filter((f) => /^\d{4}-[a-z0-9-]+\.md$/.test(f));
const rootScripts = Object.keys(
  (JSON.parse(read(join(ROOT, 'package.json'))) as { scripts: Record<string, string> }).scripts,
);

// Hand-written docs a new developer follows; generated or plan files are out of scope.
const DOCS = [
  'README.md',
  'ARCHITECTURE.md',
  'TROUBLESHOOTING.md',
  'CHANGELOG.md',
  'docs/adr/README.md',
  'docs/runbooks/queues.md',
  ...adrFiles.map((f) => `docs/adr/${f}`),
];

/** Strips fenced code blocks so links inside examples are not checked. */
const prose = (md: string) => md.replace(/```[\s\S]*?```/g, '');

describe('project docs', () => {
  it('[S0-16] each ADR states status, context, decision and consequences', () => {
    expect(adrFiles.length).toBeGreaterThanOrEqual(12);
    for (const file of adrFiles) {
      const md = read(join(ADR_DIR, file));
      const missing = ['- **Status:**', '\n## Context', '\n## Decision', '\n## Consequences'].filter(
        (s) => !md.includes(s),
      );
      expect(missing, file).toEqual([]);
      expect(md.startsWith(`# ADR ${file.slice(0, 4)} — `), `${file} title`).toBe(true);
    }
  });

  it('[S0-16] ADR numbers are unique and every ADR is in the index', () => {
    const numbers = adrFiles.map((f) => f.slice(0, 4));
    expect(new Set(numbers).size).toBe(numbers.length);
    const index = read(join(ADR_DIR, 'README.md'));
    for (const file of adrFiles) expect(index, file).toContain(`](${file})`);
  });

  it('[S0-16] README setup steps use only scripts that exist', () => {
    const builtins = new Set(['install', 'i', 'dlx', 'exec', 'add', 'run']);
    for (const doc of ['README.md', 'TROUBLESHOOTING.md', 'docs/runbooks/queues.md']) {
      const used = [...read(join(ROOT, doc)).matchAll(/\bpnpm ([a-z][a-z0-9:-]*)/g)].map((m) => m[1] as string);
      const unknown = used.filter((s) => !builtins.has(s) && !rootScripts.includes(s));
      expect(unknown, doc).toEqual([]);
    }
  });

  it('[S0-16] relative links in the docs resolve', () => {
    const broken: string[] = [];
    for (const doc of DOCS) {
      const abs = join(ROOT, doc);
      for (const m of prose(read(abs)).matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = (m[1] as string).split('#')[0] as string;
        if (target === '' || /^[a-z]+:/i.test(target)) continue;
        const resolved = join(dirname(abs), decodeURI(target));
        if (!existsSync(resolved)) broken.push(`${doc} → ${relative(ROOT, resolved)}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
