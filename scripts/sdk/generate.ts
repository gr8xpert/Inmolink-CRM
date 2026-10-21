/**
 * `pnpm sdk:generate` (S7-03): writes `packages/sdk/openapi.json` (website API v2 operations of feed-api's OpenAPI)
 * and `packages/sdk/src/website-v2.generated.ts` (typed operation table). Run it whenever a `/v2` route or its
 * contracts change; `tests/workspace/sdk.test.ts` fails while the committed files are stale.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger } from '@inmolink/platform/logger';
import { buildApp } from '../../apps/feed-api/src/app';
import { type OpenApiDoc, renderJson, renderTs, websiteSpec } from './render';

const ROOT = resolve(import.meta.dirname, '..', '..');
export const SDK_FILES = {
  json: resolve(ROOT, 'packages/sdk/openapi.json'),
  ts: resolve(ROOT, 'packages/sdk/src/website-v2.generated.ts'),
} as const;

/** feed-api's OpenAPI document, from the app itself (no server, no database). */
export async function feedApiOpenApi(): Promise<OpenApiDoc> {
  const app = await buildApp({
    logger: createLogger({ level: 'silent' }),
    trustProxy: false,
    docsUi: false,
    limiter: { consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }) } as never,
    checks: {},
  });
  try {
    await app.ready();
    return app.swagger() as unknown as OpenApiDoc;
  } finally {
    await app.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const spec = websiteSpec(await feedApiOpenApi());
  writeFileSync(SDK_FILES.json, renderJson(spec));
  writeFileSync(SDK_FILES.ts, renderTs(spec));
  const biome = spawnSync('npx', ['biome', 'format', '--write', SDK_FILES.json], { cwd: ROOT, shell: true });
  if (biome.status !== 0) throw new Error(`biome format failed: ${biome.stderr}`);
  console.log(`sdk: ${Object.keys(spec.paths).length} paths → packages/sdk/openapi.json, src/website-v2.generated.ts`);
}
