import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { feedApiOpenApi, SDK_FILES } from '../../scripts/sdk/generate';
import { renderTs, typeOf, websiteSpec } from '../../scripts/sdk/render';

describe('website API SDK (S7-03)', () => {
  it('[S7-03] the committed OpenAPI and SDK match feed-api (run `pnpm sdk:generate` after changing /v2)', async () => {
    const spec = websiteSpec(await feedApiOpenApi());
    expect(JSON.parse(readFileSync(SDK_FILES.json, 'utf8'))).toEqual(JSON.parse(JSON.stringify(spec)));
    expect(readFileSync(SDK_FILES.ts, 'utf8')).toBe(renderTs(spec));
    // Every v2 read endpoint is in it.
    const ops = Object.values(spec.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
    for (const op of [
      'websiteV2.listListings',
      'websiteV2.getListing',
      'websiteV2.listChanges',
      'websiteV2.getSitemap',
    ]) {
      expect(ops).toContain(op);
    }
  }, 120_000);

  it('[S7-03] JSON Schemas become TypeScript types', () => {
    expect(
      typeOf({
        type: 'object',
        properties: { a: { type: 'string', nullable: true }, b: { type: 'array', items: { enum: ['X', 'Y'] } } },
        required: ['a'],
      }),
    ).toBe('{\n  a: string | null;\n  b?: Array<"X" | "Y">;\n}');
    expect(typeOf({ type: 'object', additionalProperties: { type: 'integer' } })).toBe('Record<string, number>');
    expect(typeOf({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('string | null');
  });
});
