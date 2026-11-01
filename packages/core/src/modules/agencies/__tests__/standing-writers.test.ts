import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * S16-F3 (S15 review): the portal (page cache, owner scope, sitemaps), API keys, site configs, search and matching all
 * react to an agency's standing through `agencies.status.changed` — there is no other "directory" event: the
 * directory's `listed` flag is derived from the status by the `agencies_directory_sync` trigger (migration 0022,
 * `listed = status = 'VERIFIED'`, in the same transaction), so a status change is the only way an agency enters or
 * leaves the directory, and the status event is the directory event.
 *
 * This contract scans the source for every code path that writes an agency's status or directory standing — Drizzle
 * and raw SQL writes of `agencies` and `agency_directory`, and seed `COPY`s, in packages, apps and scripts (tests
 * excluded), and every migration — and holds each against the list below. A writer that is not listed fails the test:
 * a future suspension or opt-out path (a new `.set({ status })`, a raw `update agencies set status`, a new directory
 * column or trigger) must emit `agenciesEvents.statusChanged` in its transaction and be added here. Every runtime
 * status writer's callers are checked to emit the event (and `emit` it) in the same function.
 */

const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
const posix = (p: string) => p.split(sep).join('/');

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', '__tests__', 'generated', 'out']);
const SOURCE = /\.(?:ts|tsx|mts|mjs|js|cjs)$/;
const TEST = /\.test\.(?:ts|tsx)$|\.d\.ts$/;

function walk(dir: string, keep: (file: string) => boolean, out: string[] = []): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full, keep, out);
    } else if (keep(full)) out.push(full);
  }
  return out;
}

const subdirs = (dir: string) =>
  readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `${dir}/${e.name}`);

/** Every non-test source file that could write the tables. */
function sourceFiles(): string[] {
  const roots = [
    ...subdirs('packages').map((p) => `${p}/src`),
    'packages/db/test',
    ...subdirs('apps').map((a) => `${a}/src`),
    'scripts',
  ];
  return roots.flatMap((r) => walk(join(ROOT, r), (f) => SOURCE.test(f) && !TEST.test(f)));
}

type Detector = 'drizzle.update' | 'drizzle.insert' | 'drizzle.delete' | 'directory' | 'sql' | 'copy';

/** A SQL write verb before the table. */
const VERB = String.raw`\b(?:update|insert\s+into|delete\s+from|copy)\s+`;
/** `public.`, `"public".`, or none. */
const SCHEMA = String.raw`(?:"?public"?\s*\.\s*)?`;

/** Each detector's match: group 1 names the table (`agencies` / `agencyDirectory` / `agency_directory`). */
const DETECTORS: { kind: (table: string, m: RegExpMatchArray) => Detector; re: RegExp }[] = [
  // Drizzle builders, the table bare or through a namespace (`schema.agencies`).
  {
    kind: (t, m) =>
      t === 'agencies' ? (`drizzle.${(m[0].match(/update|insert|delete/) as string[])[0]}` as Detector) : 'directory',
    re: /\.(?:update|insert|delete)\(\s*(?:[\w$]+\.)?(agencies|agencyDirectory)\s*\)/g,
  },
  // Drizzle raw SQL with the table interpolated: sql`update ${agencies} set …`.
  {
    kind: (t) => (t === 'agencies' ? 'sql' : 'directory'),
    re: new RegExp(`${VERB}\\$\\{\\s*(?:[\\w$]+\\.)?(agencies|agencyDirectory)\\s*\\}`, 'gi'),
  },
  // Literal SQL, plain or quoted names.
  {
    kind: (t) => (t === 'agencies' ? 'sql' : 'directory'),
    re: new RegExp(`${VERB}${SCHEMA}"?(agencies|agency_directory)"?(?=[\\s(;"\`']|$)`, 'gi'),
  },
  // Seeds' bulk COPY helpers name the table as a string argument.
  {
    kind: () => 'copy',
    re: /\bcopy\w*\(\s*\w+\s*,\s*['"](?:public\.)?(agencies|agency_directory)['"]/gi,
  },
];

/** An aliased import (or destructured rename) of the tables hides writes from the detectors: refused outright. */
const ALIASED = [
  /\b(?:import|export)\s*(?:type\s*)?\{[^}]*\b(?:agencies|agencyDirectory)\s+as\s+[\w$]+[^}]*\}/g,
  // `const { agencies: a } = schema` / `= await import('…/schema…')` (a result object's `agencies` field is fine).
  /\{[^}]*\b(?:agencies|agencyDirectory)\s*:\s*[\w$]+[^}]*\}\s*=\s*(?:await\s+import\([^)]*schema|[\w$]*[sS]chema\b)/g,
];

/** A change to the directory table's shape (a new column could be a new standing — an opt-out flag). */
const ALTER_DIRECTORY =
  /\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:"?public"?\.)?"?agency_directory"?\s+(?:add|alter|drop|rename)\b/i;

/** The nearest top-level declaration before `index` (the writer's function), or `<module>`. */
function enclosingName(text: string, index: number): string {
  const decl =
    /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/gm;
  let name = '<module>';
  for (const m of text.slice(0, index).matchAll(decl)) name = (m[1] ?? m[2]) as string;
  return name;
}

/**
 * Whether a Drizzle write may set the status: its `set`/`values` (up to `where`/`returning`/`onConflict`) names
 * `status`, is not an object literal, spreads a variable (a caller's wider object could carry `status`), or the
 * statement upserts (`onConflictDoUpdate`: any column).
 */
function drizzleWritesStatus(text: string, index: number): boolean {
  const rest = text.slice(index);
  const stmtEnd = rest.search(/;|\n\s*\n/);
  const stmt = rest.slice(0, stmtEnd === -1 ? 2_000 : stmtEnd);
  if (/onConflictDoUpdate/.test(stmt)) return true;
  const segEnd = stmt.search(/\.where\(|\.returning\(|\.onConflict/);
  const seg = stmt.slice(0, segEnd === -1 ? undefined : segEnd);
  if (/\bstatus\b|\blisted\b/.test(seg)) return true;
  const arg = /\.(?:set|values)\(\s*(\S)/.exec(seg);
  if (arg && arg[1] !== '{' && arg[1] !== '[') return true;
  return /\.\.\.\s*[A-Za-z_$][\w$.]*\s*[,})\]]/.test(seg);
}

/** The SQL string literal a write is in (to its own closing delimiter). */
function writeText(text: string, index: number): string {
  // The literal's own delimiter: the nearest quote before the match.
  const before = text.slice(Math.max(0, index - 400), index);
  const open = Math.max(before.lastIndexOf('`'), before.lastIndexOf("'"), before.lastIndexOf('"'));
  const quote = open === -1 ? '`' : (before[open] as string);
  const close = text.indexOf(quote, index);
  return text.slice(index, close === -1 ? index + 400 : close);
}

interface Writer {
  file: string;
  fn: string;
  kind: Detector;
  /** The write names the status column (or the directory's `listed`). */
  status: boolean;
}

/** One file's writers and aliased imports. */
function scanText(file: string, text: string, out: Writer[], aliased: string[]): void {
  for (const re of ALIASED) for (const m of text.matchAll(re)) aliased.push(`${file}: ${m[0].slice(0, 80)}`);
  for (const { kind: kindOf, re } of DETECTORS) {
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0;
      const kind = kindOf(m[1] as string, m);
      // A directory write, a delete (the directory row cascades) or a COPY (any column) always counts.
      const always = kind === 'directory' || kind === 'drizzle.delete' || kind === 'copy';
      const status =
        always ||
        (kind.startsWith('drizzle')
          ? drizzleWritesStatus(text, at)
          : /\bstatus\b|\blisted\b|on\s+conflict[^;]*do\s+update/i.test(writeText(text, at)));
      out.push({ file, fn: enclosingName(text, at), kind, status });
    }
  }
}

function scanWriters(): { writers: Writer[]; aliased: string[] } {
  const out: Writer[] = [];
  const aliased: string[] = [];
  for (const full of sourceFiles()) {
    const text = readFileSync(full, 'utf8');
    if (!/agencies|agencyDirectory|agency_directory/.test(text)) continue;
    scanText(posix(relative(ROOT, full)), text, out, aliased);
  }
  return { writers: out, aliased };
}

/**
 * Every writer of `agencies` / `agency_directory` outside tests. `emits`: a runtime status writer — each of its callers
 * emits `agenciesEvents.statusChanged`. `exempt`: why it needs no event. `status: false`: writes other columns only
 * (the trigger copies a rename to the directory; the standing — `listed` — follows the status alone).
 */
const KNOWN: Record<string, { status: boolean; emits?: true; exempt?: string }> = {
  // Runtime (agencies module repos)
  'packages/core/src/modules/agencies/repo.ts::insertAgency::drizzle.insert': {
    status: false,
    exempt: 'sign-up: a new PENDING agency (column default) — never listed, nothing to invalidate',
  },
  'packages/core/src/modules/agencies/repo.ts::replaceSignupAgency::drizzle.update': { status: false },
  'packages/core/src/modules/agencies/repo.ts::updateDetails::drizzle.update': { status: false },
  'packages/core/src/modules/agencies/repo.ts::changeStatus::drizzle.update': { status: true, emits: true },
  'packages/core/src/modules/agencies/tenants-repo.ts::setGiveToGetExempt::drizzle.update': { status: false },
  // Seeds, fixtures and test helpers (never a runtime path)
  'packages/db/test/test-db.ts::setAgencyStatus::sql': {
    status: true,
    exempt: 'test helper over the admin connection (app tests need a verified agency without the staff flow)',
  },
  'scripts/perf/lighthouse-fixture.ts::seedEmbedFixture::sql': { status: false },
  'scripts/perf/smoke.ts::runDashboardSmoke::sql': { status: false },
  'scripts/perf/smoke.ts::provisioned::sql': { status: false },
  'scripts/seed/agencies.ts::writeRows::copy': {
    status: true,
    exempt: 'seed: COPY of new agencies (nothing cached about them yet; the directory row comes from the trigger)',
  },
};

const keyOf = (w: Writer) => `${w.file}::${w.fn}::${w.kind}`;

describe('agency standing writers emit the status event (S16-F3)', () => {
  const { writers, aliased } = scanWriters();
  const found = new Map<string, Writer>();
  for (const w of writers) {
    const k = keyOf(w);
    const prev = found.get(k);
    // Several writes in one function: one entry, status if any of them writes it.
    found.set(k, prev ? { ...w, status: prev.status || w.status } : w);
  }

  it('[S16-F3] the contract test lists every writer of an agency’s status or directory standing', () => {
    expect(aliased, 'import agencies / agencyDirectory under their own names: the writer scan looks for them').toEqual(
      [],
    );
    const unknown = [...found.keys()].filter((k) => !(k in KNOWN));
    expect(
      unknown,
      'a new writer of agencies / agency_directory: if it changes the status (a suspension, an opt-out), emit ' +
        'agenciesEvents.statusChanged in its transaction; then classify it in KNOWN',
    ).toEqual([]);
    const gone = Object.keys(KNOWN).filter((k) => !found.has(k));
    expect(gone, 'a listed writer is gone (or renamed): update KNOWN').toEqual([]);
    for (const [k, w] of found) {
      const known = KNOWN[k];
      if (!known) continue;
      expect(w.status, `${k}: writes the status? update KNOWN`).toBe(known.status);
      // A status writer is either a runtime writer whose callers emit, or exempt with a reason — and exempt only
      // outside the runtime code (packages/core, apps).
      if (known.status) {
        expect(Boolean(known.emits) !== Boolean(known.exempt), k).toBe(true);
        if (known.exempt) expect(w.file.startsWith('packages/core/') || w.file.startsWith('apps/'), k).toBe(false);
      }
    }
    // No runtime code writes the directory itself: only the trigger does.
    expect(writers.filter((w) => w.kind === 'directory').map(keyOf)).toEqual([]);
  });

  it('[S16-F3] every caller of a runtime status writer emits agencies.status.changed in the same function', () => {
    // Callers anywhere in the scanned roots (the repo is the agencies module's, but nothing else is assumed).
    const files = sourceFiles();
    const writersFns = Object.entries(KNOWN)
      .filter(([, v]) => v.emits)
      .map(([k]) => k.split('::')[1] as string);
    expect(writersFns.length).toBeGreaterThan(0);
    for (const fn of writersFns) {
      const callers: string[] = [];
      for (const full of files) {
        const text = readFileSync(full, 'utf8');
        for (const m of text.matchAll(new RegExp(`\\b${fn}\\(`, 'g'))) {
          const at = m.index ?? 0;
          if (/function\s*$/.test(text.slice(Math.max(0, at - 20), at))) continue; // its declaration
          const name = enclosingName(text, at);
          const start = text.slice(0, at).lastIndexOf(name);
          const next = text.slice(at).search(/\n(?:export\s+)?(?:async\s+)?function\s|\nexport\s+const\s/);
          const body = text.slice(start, next === -1 ? undefined : at + next);
          const where = `${posix(relative(ROOT, full))}::${name}`;
          callers.push(where);
          expect(body, `${where} calls ${fn} without agenciesEvents.statusChanged`).toMatch(
            /agenciesEvents\.statusChanged\(/,
          );
          expect(body, `${where} builds the event but never emits it`).toMatch(/\bemit\(/);
        }
      }
      // Its only callers today: the staff verification decision (S1-03).
      expect(callers, fn).toEqual(['packages/core/src/modules/agencies/verification.ts::decideVerification']);
    }
  });

  it('[S16-F3] the writer scan sees raw, quoted, namespaced, upsert and spread writes, and aliased imports', () => {
    const probe = [
      "import { agencies as a } from '@inmolink/db/schema/agencies';",
      'export async function p1(tx) {',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
      "  await tx.execute(sql`update ${agencies} set status = 'SUSPENDED' where agency_id = ${id}`);",
      '}',
      'export async function p2(c) {',
      `  await c.query('update "public"."agencies" set status = $2 where agency_id = $1', [id, s]);`,
      '}',
      'export async function p3(tx) {',
      "  await tx.update(schema.agencies).set({ name: 'x' }).where(x);",
      '}',
      'export async function p4(tx) {',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
      '  await tx.execute(sql`insert into ${agencyDirectory} (agency_id) values (${id})`);',
      '}',
      'export async function p5(tx) {',
      '  await tx.insert(agencies).values({ id }).onConflictDoUpdate({ target: agencies.id, set: x });',
      '}',
      'export async function p6(tx, patch) {',
      '  await tx.update(agencies).set({ ...patch, updatedAt: now }).where(x);',
      '}',
      'export async function p7(tx, patch) {',
      '  await tx.update(agencies).set(patch).where(x);',
      '}',
      'export async function p8(tx) {',
      "  await tx.update(agencies).set({ name: 'x' }).where(eq(agencies.status, 'PENDING'));",
      '}',
    ].join('\n');
    const out: Writer[] = [];
    const alias: string[] = [];
    scanText('probe.ts', probe, out, alias);
    expect(alias).toHaveLength(1);
    expect(Object.fromEntries(out.map((w) => [`${w.fn}:${w.kind}`, w.status]))).toEqual({
      'p1:sql': true,
      'p2:sql': true,
      'p3:drizzle.update': false,
      'p4:directory': true,
      'p5:drizzle.insert': true,
      'p6:drizzle.update': true,
      'p7:drizzle.update': true,
      'p8:drizzle.update': false, // the status only in the row filter: not written
    });
  });

  it('[S16-F3] the directory standing follows the status alone: one trigger writes agency_directory', () => {
    const dir = join(ROOT, 'packages/db/migrations');
    // SQL outside the migrations (init scripts, generated RLS) never writes the tables either.
    const stray = walk(ROOT, (f) => f.endsWith('.sql') && !posix(f).includes('/packages/db/migrations/'));
    expect(stray.length).toBeGreaterThan(0);
    for (const full of stray) {
      const sql = readFileSync(full, 'utf8');
      const where = posix(relative(ROOT, full));
      expect(sql, `${where} writes agency_directory`).not.toMatch(
        new RegExp(`${VERB}${SCHEMA}"?agency_directory"?\\b`, 'i'),
      );
      expect(sql, `${where} updates agencies.status`).not.toMatch(
        /\bupdate\s+(?:"?public"?\.)?"?agencies"?\s+set\b[^;]*\bstatus\s*=/i,
      );
      expect(sql, `${where} alters agency_directory`).not.toMatch(ALTER_DIRECTORY);
    }
    const writes: string[] = [];
    const alters: string[] = [];
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
      const sql = readFileSync(join(dir, name), 'utf8');
      // A later column or default on the directory (an opt-out flag?) is a new standing: classify it here first.
      if (ALTER_DIRECTORY.test(sql)) alters.push(name);
      for (const m of sql.matchAll(new RegExp(`${VERB}${SCHEMA}"?agency_directory"?\\b`, 'gi'))) {
        writes.push(`${name}::${enclosingSqlFunction(sql, m.index ?? 0)}`);
      }
      // A database function changing an agency's status would bypass the event: none may exist.
      expect(sql, `${name} updates agencies.status in SQL`).not.toMatch(
        /\bupdate\s+(?:"?public"?\.)?"?agencies"?\s+set\b[^;]*\bstatus\s*=/i,
      );
    }
    expect(alters, 'agency_directory altered after it was created (0021): a new standing column?').toEqual([
      '0021_preferred_agencies.sql',
    ]);
    expect(writes.sort()).toEqual([
      '0022_preferred_agencies_guard.sql::<backfill>', // one-off: the agencies verified before the directory existed
      '0022_preferred_agencies_guard.sql::agencies_directory_sync',
    ]);
    const sync = readFileSync(join(dir, '0022_preferred_agencies_guard.sql'), 'utf8');
    expect(sync).toMatch(/values \(new\.agency_id, new\.name, new\.kind, new\.status = 'VERIFIED', now\(\)\)/);
    expect(sync).toMatch(/after insert or update of status, name, kind on agencies/);
  });
});

/** The SQL function a statement is in (`create … function <name>()` before it, up to its `$$` end), or `<backfill>`. */
function enclosingSqlFunction(sql: string, index: number): string {
  const before = sql.slice(0, index);
  const fn = [...before.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(/gi)].pop();
  if (!fn) return '<backfill>';
  const ends = before.slice(fn.index ?? 0).match(/end\s*\$\$/gi);
  return ends ? '<backfill>' : (fn[1] as string);
}
