import type { XmlElement } from '@inmolink/platform/xml';

/**
 * The field-coverage machinery of the XML format connectors (S6-07). Each format has a table of rules (`FieldRule`:
 * an element or attribute path relative to the record, the `FeedListing` field it feeds, or why it is ignored). A
 * test walks every fixture record against the table and computes the report below, so a field nobody accounted for
 * fails the test, and the unmapped fields are always listed.
 *
 * Paths: `child/grandchild`, attributes as `path@attr` (a record's own attributes as `@attr`). A `*` segment matches
 * any one element name.
 */
export interface FieldRule {
  path: string;
  /** The `FeedListing` field(s) it feeds; null when ignored. */
  maps: string | null;
  /** Why an ignored field is ignored, or how a mapped one is read. */
  note: string;
}

/** Paths (elements and `@attributes`) below a record, relative to it, without duplicates. */
export function fieldPaths(record: XmlElement): string[] {
  const out = new Set<string>();
  for (const attr of Object.keys(record.attributes)) out.add(`@${attr}`);
  const walk = (el: XmlElement, path: string) => {
    out.add(path);
    for (const attr of Object.keys(el.attributes)) out.add(`${path}@${attr}`);
    for (const child of el.children) walk(child, `${path}/${child.name}`);
  };
  for (const child of record.children) walk(child, child.name);
  return [...out];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wildcard = (path: string) => new RegExp(`^${path.split('*').map(escapeRe).join('[^/@]+')}$`);

export function createRuleIndex(rules: readonly FieldRule[]) {
  const exact = new Map(rules.map((r) => [r.path, r]));
  const wild = rules.filter((r) => r.path.includes('*')).map((r) => ({ rule: r, re: wildcard(r.path) }));
  return (path: string): FieldRule | undefined => exact.get(path) ?? wild.find((w) => w.re.test(path))?.rule;
}

export interface CoverageReport {
  /** Distinct field paths found in the fixture records. */
  fields: string[];
  /** Fields that feed a listing field. */
  mapped: string[];
  /** Fields the table accounts for as ignored (the reason is in the table): the "unmapped fields" list. */
  unmapped: string[];
  /** Fields the table does not know at all (a new element in the format). */
  unaccounted: string[];
  /** Rules no fixture field exercises. */
  unexercised: string[];
  /** Share of fields that feed a listing field, 0-100. */
  mappedPct: number;
  /** Share of fields the table accounts for (mapped, or ignored for a stated reason), 0-100. */
  accountedPct: number;
}

export function coverageReport(rules: readonly FieldRule[], records: readonly XmlElement[]): CoverageReport {
  const ruleFor = createRuleIndex(rules);
  const fields = [...new Set(records.flatMap(fieldPaths))].sort();
  const mapped: string[] = [];
  const unmapped: string[] = [];
  const unaccounted: string[] = [];
  const used = new Set<string>();
  for (const f of fields) {
    const rule = ruleFor(f);
    if (!rule) unaccounted.push(f);
    else {
      used.add(rule.path);
      (rule.maps ? mapped : unmapped).push(f);
    }
  }
  const pct = (n: number) => (fields.length === 0 ? 0 : Math.round((n / fields.length) * 1000) / 10);
  return {
    fields,
    mapped,
    unmapped,
    unaccounted,
    unexercised: rules.map((r) => r.path).filter((p) => !used.has(p)),
    mappedPct: pct(mapped.length),
    accountedPct: pct(mapped.length + unmapped.length),
  };
}

/** The coverage table as Markdown. */
export function renderRules(title: string, rules: readonly FieldRule[]): string {
  const rows = rules.map((r) => `| \`${r.path}\` | ${r.maps ? `\`${r.maps}\`` : 'ignored'} | ${r.note} |`);
  return [`| ${title} field | Maps to | Note |`, '| --- | --- | --- |', ...rows].join('\n');
}
