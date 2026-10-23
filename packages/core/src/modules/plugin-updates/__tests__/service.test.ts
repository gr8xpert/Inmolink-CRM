import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { pluginSigningMessage } from '@inmolink/contracts';
import { configureStorage, createMemoryStore } from '@inmolink/platform/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  latestPluginRelease,
  PLUGIN_LATEST_KEY,
  pluginPackage,
  pluginReleaseKeys,
  publishPluginRelease,
  resetPluginReleaseCache,
} from '../index';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const signer = (message: Uint8Array) => new Uint8Array(sign(null, message, privateKey));
const input = (version: string) => ({
  version,
  requires: '6.4',
  requiresPhp: '8.1',
  tested: '6.8',
  commit: 'a'.repeat(40),
  changelog: `Release ${version}`,
});
const zip = (text: string) => new TextEncoder().encode(`PK fake zip ${text}`);

describe('plugin update server (S8-05)', () => {
  let store: ReturnType<typeof createMemoryStore>;
  beforeEach(() => {
    store = createMemoryStore();
    configureStorage(store);
    resetPluginReleaseCache();
  });

  it('[S8-05] a published release is signed over slug, version and SHA-256, and offered as the latest', async () => {
    const manifest = await publishPluginRelease(store, zip('1.0.0'), input('1.0.0'), signer);
    const ok = verify(
      null,
      Buffer.from(pluginSigningMessage('1.0.0', manifest.sha256)),
      publicKey,
      Buffer.from(manifest.signature, 'base64'),
    );
    expect(ok).toBe(true);

    const info = await latestPluginRelease();
    expect(info).toMatchObject({ slug: 'inmolink', version: '1.0.0', package: '/v2/plugin/package/1.0.0' });
    expect(info).not.toHaveProperty('commit');

    const { body, manifest: stored } = await pluginPackage('1.0.0');
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString()).toBe('PK fake zip 1.0.0');
    expect(stored.sha256).toBe(manifest.sha256);
  });

  it('[S8-05] versions are immutable and latest never moves backwards', async () => {
    await publishPluginRelease(store, zip('1.1.0'), input('1.1.0'), signer);
    await expect(
      publishPluginRelease(store, zip('other bytes'), { ...input('1.1.0'), commit: 'c'.repeat(40) }, signer),
    ).rejects.toThrow(/already published/);
    await publishPluginRelease(store, zip('1.0.5'), input('1.0.5'), signer);
    resetPluginReleaseCache();
    expect((await latestPluginRelease()).version).toBe('1.1.0');
    expect(await store.head('feeds', pluginReleaseKeys('1.0.5').zip)).not.toBeNull();
    // Re-publishing the same bytes is a no-op that may re-point latest.
    await publishPluginRelease(store, zip('1.1.0'), input('1.1.0'), signer);
  });

  it('[S8-05] no release, a malformed manifest or an unknown version answer PLUGIN_RELEASE_NOT_FOUND', async () => {
    await expect(latestPluginRelease()).rejects.toMatchObject({ code: 'PLUGIN_RELEASE_NOT_FOUND' });
    await store.put('feeds', PLUGIN_LATEST_KEY, new TextEncoder().encode('{"slug":"other"}'), {
      contentType: 'application/json',
    });
    await expect(latestPluginRelease()).rejects.toMatchObject({ code: 'PLUGIN_RELEASE_NOT_FOUND' });
    await expect(pluginPackage('9.9.9')).rejects.toMatchObject({ code: 'PLUGIN_RELEASE_NOT_FOUND' });
    await store.put('feeds', PLUGIN_LATEST_KEY, new TextEncoder().encode('{"truncated'), {
      contentType: 'application/json',
    });
    resetPluginReleaseCache();
    await expect(latestPluginRelease()).rejects.toMatchObject({ code: 'PLUGIN_RELEASE_NOT_FOUND' });
  });

  it('[S8-05] a damaged release is never overwritten; the same commit re-zipped is the same release', async () => {
    await store.put('feeds', pluginReleaseKeys('2.0.0').manifest, new TextEncoder().encode('not json'), {
      contentType: 'application/json',
    });
    await expect(publishPluginRelease(store, zip('2.0.0'), input('2.0.0'), signer)).rejects.toThrow(/unreadable/);
    await store.put('feeds', pluginReleaseKeys('2.1.0').zip, zip('orphan'), { contentType: 'application/zip' });
    await expect(publishPluginRelease(store, zip('2.1.0'), input('2.1.0'), signer)).rejects.toThrow(/no release.json/);

    const first = await publishPluginRelease(store, zip('2.2.0'), input('2.2.0'), signer);
    const again = await publishPluginRelease(store, zip('2.2.0 other git'), input('2.2.0'), signer);
    expect(again.sha256).toBe(first.sha256);
  });
});
