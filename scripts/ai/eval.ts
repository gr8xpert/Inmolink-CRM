// pnpm ai:eval <feature> [--version <n>] [--schema <file.ts>#<export>] [--live [--record]]
//
// Runs the eval set of one AI feature (S12-01, PLAN §8): `packages/core/evals/<feature>/*.jsonl` against the prompt
// `packages/core/prompts/<feature>/v<n>.md` (default: its newest version). Without `--live` it checks the recorded
// answers — no provider call, no key (what CI runs). `--live` asks the provider through the gateway (needs
// AI_PROVIDER=anthropic, the key, the model tiers and prices in .env; costs money, unmetered: no tenant).
// `--record` (with `--live`) saves the live answers as the recordings for that prompt version.
// `--schema` (structured features, e.g. S12-03 / S12-08): a Zod schema module and export; recorded and live answers
// must match it, and live runs go through `ai.structured` (validated, one repair retry). Exits 1 when any case fails.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createAiGatewayFromEnv, listPrompts, loadEvalCases, runEval } from '@inmolink/platform/ai';
import type { ZodType } from 'zod';

const PROMPTS_DIR = fileURLToPath(new URL('../../packages/core/prompts', import.meta.url));
const EVALS_DIR = fileURLToPath(new URL('../../packages/core/evals', import.meta.url));

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    version: { type: 'string' },
    schema: { type: 'string' },
    live: { type: 'boolean', default: false },
    record: { type: 'boolean', default: false },
  },
});

const feature = positionals[0];
if (!feature || !/^[a-z][a-z0-9-]{0,62}$/.test(feature)) {
  console.error('usage: pnpm ai:eval <feature> [--version <n>] [--schema <file.ts>#<export>] [--live [--record]]');
  process.exit(2);
}
if (values.record && !values.live) {
  console.error('--record needs --live');
  process.exit(2);
}

const versions = (await listPrompts(PROMPTS_DIR)).filter((p) => p.id === feature);
if (versions.length === 0) {
  console.error(`no prompt files for "${feature}" in packages/core/prompts/${feature}/`);
  process.exit(2);
}
const prompt = values.version
  ? versions.find((p) => p.version === Number(values.version))
  : versions[versions.length - 1];
if (!prompt) {
  console.error(`prompt ${feature}/v${values.version} not found`);
  process.exit(2);
}

let schema: ZodType | undefined;
if (values.schema) {
  const [file, name = 'default'] = values.schema.split('#');
  const mod = (await import(pathToFileURL(resolve(file as string)).href)) as Record<string, unknown>;
  const found = mod[name];
  if (!found || typeof (found as ZodType).safeParse !== 'function') {
    console.error(`--schema: ${name} in ${file} is not a Zod schema`);
    process.exit(2);
  }
  schema = found as ZodType;
}

let live: ((input: unknown) => Promise<string>) | undefined;
if (values.live) {
  // The key stays in the environment: never printed.
  if (existsSync('.env')) process.loadEnvFile('.env');
  const gateway = createAiGatewayFromEnv({ promptsDir: PROMPTS_DIR, store: null, cache: null });
  const ctx = { unmetered: 'ai.eval' };
  const call = {
    feature: `eval.${feature}`,
    prompt: { id: prompt.id, version: prompt.version },
    cacheKey: false as const,
  };
  live = async (input) =>
    schema
      ? JSON.stringify((await gateway.structured(ctx, { ...call, input, schema })).data)
      : (await gateway.generate(ctx, { ...call, input })).text;
}

const outcomes = await runEval({
  feature,
  prompt,
  files: await loadEvalCases(EVALS_DIR, feature),
  live,
  record: values.record,
  schema,
});

let failed = 0;
for (const o of outcomes) {
  if (o.passed) console.log(`  ok    ${o.name}`);
  else {
    failed++;
    console.log(`  FAIL  ${o.name}: ${o.failures.join('; ')}`);
  }
}
console.log(
  `\n${feature} v${prompt.version} (${values.live ? 'live' : 'recorded'}): ${outcomes.length - failed}/${outcomes.length} passed`,
);
process.exit(failed > 0 ? 1 : 0);
