import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AI_TIERS, type AiTier, type PromptRef } from './types';

/**
 * Prompt registry (PLAN §8, ADR 0008 #5, `.claude/rules/ai.md`): one file per version, `<dir>/<id>/v<N>.md`, with a
 * front-matter block and the system prompt as body. A change is a new version; old versions stay so jobs and
 * feedback that name them keep their meaning. `prompt_versions` records each version's content hash
 * (`syncPromptVersions`).
 *
 * ```md
 * ---
 * tier: FAST
 * maxTokens: 2000
 * schema: ListingCopy        # optional: the output schema's name (documentation, eval reports)
 * description: one line
 * ---
 * You write property descriptions… (stable text only; the variable input is sent after it)
 * ```
 */
export interface Prompt {
  id: string;
  version: number;
  tier: AiTier;
  maxTokens: number;
  schema: string | null;
  description: string;
  system: string;
  /** Hex SHA-256 of the whole file. */
  hash: string;
}

const ID_RE = /^[a-z][a-z0-9-]{0,62}$/;
const FILE_RE = /^v([1-9]\d{0,3})\.md$/;
const MAX_TOKENS_LIMIT = 64_000;

export function assertPromptRef(ref: PromptRef): void {
  if (!ID_RE.test(ref.id)) throw new TypeError(`invalid prompt id "${String(ref.id).slice(0, 40)}"`);
  if (!Number.isInteger(ref.version) || ref.version < 1 || ref.version > 9_999) {
    throw new TypeError('prompt version must be a positive integer');
  }
}

/** Parses a prompt file's text. Throws on a missing or malformed front-matter block. */
export function parsePrompt(ref: PromptRef, text: string): Prompt {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(normalized);
  if (!match) throw new Error(`prompt ${ref.id}/v${ref.version}: missing front matter`);
  const meta = new Map<string, string>();
  for (const line of (match[1] ?? '').split('\n')) {
    const trimmed = line.replace(/\s+#.*$/, '').trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf(':');
    if (at <= 0) throw new Error(`prompt ${ref.id}/v${ref.version}: bad front-matter line`);
    meta.set(trimmed.slice(0, at).trim(), trimmed.slice(at + 1).trim());
  }
  const tier = meta.get('tier') as AiTier | undefined;
  if (!tier || !AI_TIERS.includes(tier))
    throw new Error(`prompt ${ref.id}/v${ref.version}: tier must be FAST or SMART`);
  const maxTokens = Number(meta.get('maxTokens'));
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS_LIMIT) {
    throw new Error(`prompt ${ref.id}/v${ref.version}: maxTokens must be 1..${MAX_TOKENS_LIMIT}`);
  }
  const system = (match[2] ?? '').trim();
  if (system === '') throw new Error(`prompt ${ref.id}/v${ref.version}: empty body`);
  return {
    id: ref.id,
    version: ref.version,
    tier,
    maxTokens,
    schema: meta.get('schema') || null,
    description: meta.get('description') ?? '',
    system,
    hash: createHash('sha256').update(normalized).digest('hex'),
  };
}

export interface PromptSource {
  load(ref: PromptRef): Promise<Prompt>;
}

/** Reads prompt files from a directory, once per process per version (files are immutable once shipped). */
export function filePromptSource(dir: string): PromptSource {
  const loaded = new Map<string, Promise<Prompt>>();
  return {
    load(ref) {
      assertPromptRef(ref);
      const key = `${ref.id}/v${ref.version}`;
      let p = loaded.get(key);
      if (!p) {
        p = readFile(join(dir, ref.id, `v${ref.version}.md`), 'utf8').then((text) => parsePrompt(ref, text));
        p.catch(() => loaded.delete(key));
        loaded.set(key, p);
      }
      return p;
    },
  };
}

/** In-memory prompts (tests). */
export function staticPromptSource(prompts: readonly Prompt[]): PromptSource {
  const byKey = new Map(prompts.map((p) => [`${p.id}/v${p.version}`, p]));
  return {
    async load(ref) {
      assertPromptRef(ref);
      const p = byKey.get(`${ref.id}/v${ref.version}`);
      if (!p) throw new Error(`prompt ${ref.id}/v${ref.version} not found`);
      return p;
    },
  };
}

/** Every prompt version under `dir` (for `syncPromptVersions` and `pnpm ai:eval`). */
export async function listPrompts(dir: string): Promise<Prompt[]> {
  const out: Prompt[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
    for (const file of await readdir(join(dir, entry.name))) {
      const m = FILE_RE.exec(file);
      if (!m) continue;
      const ref = { id: entry.name, version: Number(m[1]) };
      out.push(parsePrompt(ref, await readFile(join(dir, entry.name, file), 'utf8')));
    }
  }
  return out.sort((a, b) => (a.id === b.id ? a.version - b.version : a.id < b.id ? -1 : 1));
}
