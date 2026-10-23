import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PluginUpdateInfo } from '@inmolink/contracts';
import * as pluginUpdates from '@inmolink/core/modules/plugin-updates';
import { createLogger } from '@inmolink/platform/logger';
import { createServer, type FastifyZod } from '@inmolink/platform/server';
import { configureStorage, createMemoryStore } from '@inmolink/platform/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OpenApiDoc, websiteSpec } from '../../../../../scripts/sdk/render';
import { pluginUpdateRoutes } from './routes';

const { privateKey } = generateKeyPairSync('ed25519');
const signer = (m: Uint8Array) => new Uint8Array(sign(null, m, privateKey));

describe('plugin update routes (S8-05)', () => {
  let app: FastifyZod;
  let store: ReturnType<typeof createMemoryStore>;

  beforeEach(async () => {
    store = createMemoryStore();
    configureStorage(store);
    pluginUpdates.resetPluginReleaseCache();
    app = await createServer({
      logger: createLogger({ level: 'silent' }),
      trustProxy: false,
      openapi: { title: 'test', version: '0' },
    });
    await app.register(pluginUpdateRoutes);
    await app.ready();
  }, 30_000);

  afterEach(async () => {
    await app.close();
  });

  it('[S8-05] serves the latest release metadata and its package, cacheable, with ETags', async () => {
    expect((await app.inject({ method: 'GET', url: '/v2/plugin/update' })).statusCode).toBe(404);

    const zip = new TextEncoder().encode('PK zip bytes');
    await pluginUpdates.publishPluginRelease(
      store,
      zip,
      { version: '1.2.0', requires: '6.4', requiresPhp: '8.1', tested: '6.8', commit: 'b'.repeat(40) },
      signer,
    );
    pluginUpdates.resetPluginReleaseCache();

    const meta = await app.inject({ method: 'GET', url: '/v2/plugin/update' });
    expect(meta.statusCode).toBe(200);
    const info = PluginUpdateInfo.parse(meta.json());
    expect(info.package).toBe('/v2/plugin/package/1.2.0');
    expect(meta.headers['cache-control']).toContain('s-maxage=60');
    const again = await app.inject({
      method: 'GET',
      url: '/v2/plugin/update',
      headers: { 'if-none-match': String(meta.headers.etag) },
    });
    expect(again.statusCode).toBe(304);

    const pkg = await app.inject({ method: 'GET', url: info.package });
    expect(pkg.statusCode).toBe(200);
    expect(pkg.headers['content-type']).toBe('application/zip');
    expect(pkg.headers['cache-control']).toContain('s-maxage=31536000');
    expect(pkg.headers.etag).toBe(`"${info.sha256}"`);
    expect(pkg.rawPayload.toString()).toBe('PK zip bytes');

    expect((await app.inject({ method: 'GET', url: '/v2/plugin/package/9.9.9' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v2/plugin/package/..%2Flatest.json' })).statusCode).toBe(422);
  });

  it('[S9-F6] plugin operations are tagged wp-plugin and left out of the customer SDK', () => {
    const doc = app.swagger() as unknown as OpenApiDoc;
    const ops = Object.entries(doc.paths).filter(([path]) => path.startsWith('/v2/plugin/'));
    expect(ops.length).toBe(2);
    for (const [, methods] of ops) {
      for (const op of Object.values(methods)) expect(op.tags).toEqual(['wp-plugin']);
    }
    expect(Object.keys(websiteSpec(doc).paths)).toEqual([]);

    // The committed SDK (`pnpm sdk:generate`) has none either.
    const committed = readFileSync(new URL('../../../../../packages/sdk/openapi.json', import.meta.url), 'utf8');
    const generated = readFileSync(
      new URL('../../../../../packages/sdk/src/website-v2.generated.ts', import.meta.url),
      'utf8',
    );
    expect(committed).not.toContain('/v2/plugin/');
    expect(generated).not.toMatch(/getPlugin(Update|Package)|plugin\/update/);
  });
});
