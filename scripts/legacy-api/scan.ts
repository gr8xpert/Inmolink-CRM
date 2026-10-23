// pnpm legacy:scan [paths …] [--allow <value>]…
//
// Personal-data scan of legacy recordings (S9-F1, S8 review). Walks JSON files (a directory recursively) and flags
// e-mail addresses, phone numbers and cadastral references — by value pattern anywhere, and any non-empty value of a
// field (or XML tag) named like one. Run before committing recorded golden files or the H2 test account's
// `fixture.json` export (S8-F20). Default paths: `tests/golden/recorded`, `tests/golden/fixture.json`,
// `tests/golden/traffic.json`. A public value that must stay (the agency's office e-mail) is passed as `--allow`
// or listed in `tests/golden/scan-allow.json` (a JSON array of strings). Exits 1 on any finding; found values are
// printed masked.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = join(import.meta.dirname, '..', '..');

export type PersonalKind = 'email' | 'phone' | 'cadastral';

export interface PersonalFinding {
  file?: string;
  /** JSON path of the value (`$.response.json.agent.email`), with `<tag>` for a match inside a text body. */
  path: string;
  kind: PersonalKind;
  value: string;
}

const FIELDS: [PersonalKind, RegExp][] = [
  ['email', /e-?mail|correo/i],
  ['phone', /phone|mobile|m[oó]vil|tel[eé]f|^tel$|^fax$|whatsapp/i],
  ['cadastral', /catastr|cadastr|ref_?cat/i],
];

const VALUES: [PersonalKind, RegExp][] = [
  ['email', /[\w.%+-]+@[a-z\d-]+(?:\.[a-z\d-]+)*\.[a-z]{2,}/gi],
  // International (+34 / 0034 …) anywhere; a Spanish 9-digit number only with separators (a bare id stays clean).
  ['phone', /(?:\+|\b00)\d{2,3}[\s.-]?\d(?:[\s.-]?\d){7,11}\b/g],
  ['phone', /\b[6789]\d{2}(?:[\s.-]\d{3}){2}\b|\b[6789]\d[\s.-]\d{3}(?:[\s.-]\d{2}){2}\b/g],
  // Referencia catastral: urban 7 digits + 2 letters + 4 digits + letter, rustic 5 digits + letter + 8 digits;
  // then 4 digits + 2 control letters.
  ['cadastral', /\b(?:\d{7}[A-Z]{2}\d{4}[A-Z]|\d{5}[A-Z]\d{8})\d{4}[A-Z]{2}\b/g],
];

const TAG = /<([\w:-]+)[^>]*>([^<]+)<\/\1>/g;

const fieldKind = (name: string) => FIELDS.find(([, re]) => re.test(name))?.[0];

/** A field value worth flagging: not blank, not a placeholder (`<redacted>`), not a flag or a small count. */
function meaningful(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t && !/^<[\w-]+>$/.test(t) ? t : null;
  }
  if (typeof v === 'number') return Math.abs(v) >= 100_000 ? String(v) : null;
  return null;
}

function scanString(text: string, path: string, out: PersonalFinding[]): void {
  for (const [kind, re] of VALUES) for (const m of text.matchAll(re)) out.push({ path, kind, value: m[0] });
  for (const m of text.matchAll(TAG)) {
    const kind = fieldKind(m[1] ?? '');
    const value = meaningful(m[2]);
    if (kind && value) out.push({ path: `${path}<${m[1]}>`, kind, value });
  }
}

/** Findings in a parsed JSON value (or a string). `inherited`: the kind of a named field above this value. */
export function scanValue(value: unknown, path = '$', inherited?: PersonalKind): PersonalFinding[] {
  const out: PersonalFinding[] = [];
  const walk = (v: unknown, p: string, kind?: PersonalKind) => {
    if (Array.isArray(v)) {
      for (const [i, x] of v.entries()) walk(x, `${p}[${i}]`, kind);
    } else if (v !== null && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`, kind ?? fieldKind(k));
    else {
      const named = kind ? meaningful(v) : null;
      if (kind && named) out.push({ path: p, kind, value: named });
      else if (typeof v === 'string') scanString(v, p, out);
    }
  };
  walk(value, path, inherited);
  return out;
}

function jsonFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((d) =>
      d.isDirectory() ? jsonFiles(join(path, d.name)) : d.name.endsWith('.json') ? [join(path, d.name)] : [],
    );
}

/** Findings in every JSON file under `paths` (missing paths are skipped), minus the `allow`ed values. */
export function scanPaths(paths: readonly string[], allow: readonly string[] = []): PersonalFinding[] {
  const allowed = new Set(allow.map((a) => a.trim().toLowerCase()));
  return paths
    .flatMap(jsonFiles)
    .flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return scanValue(parsed).map((f) => ({ ...f, file }));
    })
    .filter((f) => !allowed.has(f.value.trim().toLowerCase()));
}

/** `file path kind va…` — the value masked so the report itself spreads nothing. */
export function formatFinding(f: PersonalFinding): string {
  const masked = f.value.length <= 4 ? '…' : `${f.value.slice(0, 2)}…(${f.value.length})`;
  return `${f.file ?? ''} ${f.path} ${f.kind} ${masked}`.trim();
}

/** The committed allow-list (`tests/golden/scan-allow.json`), or none. */
export function allowList(dir: string): string[] {
  const path = join(dir, 'scan-allow.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as string[]) : [];
}

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { allow: { type: 'string', multiple: true } },
  });
  const golden = join(ROOT, 'tests', 'golden');
  const paths = positionals.length
    ? positionals
    : [join(golden, 'recorded'), join(golden, 'fixture.json'), join(golden, 'traffic.json')];
  const findings = scanPaths(paths, [...allowList(golden), ...(values.allow ?? [])]);
  for (const f of findings) console.error(formatFinding(f));
  console.log(`${findings.length} personal value(s) found`);
  if (findings.length > 0) process.exit(1);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) main();
