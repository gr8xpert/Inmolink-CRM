import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { stableJson } from './gateway';
import type { Prompt } from './prompts';

/**
 * `pnpm ai:eval <feature>` (S12-01, PLAN §8 "evaluation sets per feature run in CI before a prompt change ships").
 * Cases live in `evals/<feature>/*.jsonl`, one JSON object per line:
 *
 * ```json
 * {"name": "plural kept", "input": {...}, "recorded": {"1": "<the model's answer for prompt v1>"},
 *  "checks": {"json": true, "sameKeys": "strings", "keepsTokens": {"path": "strings", "pattern": "\\{[a-zA-Z]+"}}}
 * ```
 *
 * By default the runner checks the **recorded** answers (no provider call, no key needed — what CI runs). `--live`
 * asks the provider instead (needs `AI_PROVIDER=anthropic` and its key; costs money), `--record` writes the live
 * answers back as the new recordings for that prompt version.
 */
const Checks = z
  .object({
    /** The answer is JSON (a Markdown code fence around it is tolerated). */
    json: z.boolean().optional(),
    /** Substrings that must appear (case-insensitive). */
    contains: z.array(z.string()).optional(),
    /** Substrings that must not appear (case-insensitive): phone numbers, agency names, "as an AI"… */
    notContains: z.array(z.string()).optional(),
    maxChars: z.number().int().positive().optional(),
    /** The object at this dotted path has exactly the same keys in the input and in the (JSON) answer. */
    sameKeys: z.string().optional(),
    /** Every match of `pattern` in each input string under `path` appears in the answer's string under the same key. */
    keepsTokens: z.object({ path: z.string(), pattern: z.string() }).optional(),
  })
  .strict();

export const EvalCase = z
  .object({
    name: z.string().min(1).max(200),
    input: z.unknown(),
    /** Recorded answers by prompt version (`"1"`, `"2"`, …). */
    recorded: z.record(z.string().regex(/^\d+$/), z.string()).default({}),
    checks: Checks,
  })
  .strict();
export type EvalCase = z.infer<typeof EvalCase>;

export interface EvalCaseFile {
  file: string;
  cases: EvalCase[];
}

export interface EvalOutcome {
  name: string;
  file: string;
  passed: boolean;
  failures: string[];
  answer: string | null;
}

export async function loadEvalCases(evalsDir: string, feature: string): Promise<EvalCaseFile[]> {
  const dir = join(evalsDir, feature);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  const out: EvalCaseFile[] = [];
  for (const file of files) {
    const lines = (await readFile(join(dir, file), 'utf8')).split(/\r?\n/).filter((l) => l.trim() !== '');
    out.push({
      file: join(dir, file),
      cases: lines.map((line, i) => {
        const parsed = EvalCase.safeParse(JSON.parse(line));
        if (!parsed.success) throw new Error(`${file}:${i + 1}: ${parsed.error.issues[0]?.message ?? 'invalid case'}`);
        return parsed.data;
      }),
    });
  }
  if (out.length === 0) throw new Error(`no eval cases in ${dir}`);
  return out;
}

function at(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseAnswer(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

/**
 * Runs one case's checks against an answer; returns the failures (empty = pass). With `schema` (structured features,
 * `pnpm ai:eval <feature> --schema …`) the answer must also be JSON that the schema accepts.
 */
export function checkAnswer(c: EvalCase, answer: string, schema?: z.ZodType): string[] {
  const failures: string[] = [];
  const checks = c.checks;
  const lower = answer.toLowerCase();
  for (const s of checks.contains ?? []) if (!lower.includes(s.toLowerCase())) failures.push(`missing "${s}"`);
  for (const s of checks.notContains ?? []) if (lower.includes(s.toLowerCase())) failures.push(`contains "${s}"`);
  if (checks.maxChars !== undefined && answer.length > checks.maxChars) {
    failures.push(`${answer.length} chars > ${checks.maxChars}`);
  }
  const needsJson =
    checks.json || checks.sameKeys !== undefined || checks.keepsTokens !== undefined || schema !== undefined;
  if (!needsJson) return failures;
  let parsed: unknown;
  try {
    parsed = parseAnswer(answer);
  } catch {
    return [...failures, 'not JSON'];
  }
  if (schema) {
    const result = schema.safeParse(parsed);
    if (!result.success) {
      const first = result.error.issues[0];
      failures.push(`schema: ${first ? `${first.path.join('.') || '(root)'} ${first.message}` : 'invalid'}`);
    }
  }
  if (checks.sameKeys !== undefined) {
    const a = at(c.input, checks.sameKeys);
    const b = at(parsed, checks.sameKeys);
    if (!isRecord(a) || !isRecord(b)) failures.push(`"${checks.sameKeys}" is not an object in input and answer`);
    else if (stableJson(Object.keys(a).sort()) !== stableJson(Object.keys(b).sort())) {
      failures.push(`keys of "${checks.sameKeys}" differ`);
    }
  }
  if (checks.keepsTokens) {
    const { path, pattern } = checks.keepsTokens;
    const a = at(c.input, path);
    const b = at(parsed, path);
    if (!isRecord(a) || !isRecord(b)) failures.push(`"${path}" is not an object in input and answer`);
    else {
      const re = new RegExp(pattern, 'g');
      for (const [k, v] of Object.entries(a)) {
        if (typeof v !== 'string') continue;
        const out = typeof b[k] === 'string' ? (b[k] as string) : '';
        for (const token of new Set(v.match(re) ?? [])) {
          if (!out.includes(token)) failures.push(`${path}.${k} lost "${token}"`);
        }
      }
    }
  }
  return failures;
}

export interface RunEvalOptions {
  feature: string;
  prompt: Prompt;
  files: EvalCaseFile[];
  /** Live mode: asks the provider (through the gateway). Omitted: the recorded answers. */
  live?: (input: unknown) => Promise<string>;
  /** With `live`: write the answers back as recordings for this prompt version. */
  record?: boolean;
  /** Structured feature: every answer must also match this schema. */
  schema?: z.ZodType;
}

export async function runEval(options: RunEvalOptions): Promise<EvalOutcome[]> {
  const version = String(options.prompt.version);
  const outcomes: EvalOutcome[] = [];
  for (const f of options.files) {
    let changed = false;
    for (const c of f.cases) {
      let answer: string | null;
      if (options.live) {
        try {
          answer = await options.live(c.input);
        } catch (err) {
          const code = err instanceof Error ? ((err as { code?: string }).code ?? err.message) : 'error';
          outcomes.push({ name: c.name, file: f.file, passed: false, failures: [`provider: ${code}`], answer: null });
          continue;
        }
        if (options.record) {
          c.recorded[version] = answer;
          changed = true;
        }
      } else {
        answer = c.recorded[version] ?? null;
      }
      if (answer === null) {
        outcomes.push({
          name: c.name,
          file: f.file,
          passed: false,
          failures: [`no recording for prompt v${version} — run with --live --record`],
          answer: null,
        });
        continue;
      }
      const failures = checkAnswer(c, answer, options.schema);
      outcomes.push({ name: c.name, file: f.file, passed: failures.length === 0, failures, answer });
    }
    if (changed) await writeFile(f.file, `${f.cases.map((c) => JSON.stringify(c)).join('\n')}\n`, 'utf8');
  }
  return outcomes;
}
