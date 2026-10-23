import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
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
      Buffer.from(pluginSigningMessage(manifest)),
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

  it('[S9-F3] the signature covers requires, tested, releasedAt and the changelog', async () => {
    const m = await publishPluginRelease(store, zip('1.2.0'), input('1.2.0'), signer);
    const ok = (f: typeof m) =>
      verify(null, Buffer.from(pluginSigningMessage(f)), publicKey, Buffer.from(m.signature, 'base64'));
    expect(ok(m)).toBe(true);
    expect(ok({ ...m, changelog: `${m.changelog} evil` })).toBe(false);
    expect(ok({ ...m, requires: '5.0' })).toBe(false);
    expect(ok({ ...m, requiresPhp: '7.0' })).toBe(false);
    expect(ok({ ...m, tested: '9.9' })).toBe(false);
    expect(ok({ ...m, releasedAt: '2020-01-01T00:00:00.000Z' })).toBe(false);
  });

  it('[S9-F3] cross-language vector: fixed fields give fixed bytes and a fixed signature (the PHP test asserts the same)', () => {
    const message = pluginSigningMessage({
      version: '1.2.3',
      sha256: 'ab'.repeat(32),
      requires: '6.4',
      requiresPhp: '8.1',
      tested: '6.8',
      releasedAt: '2026-10-23T10:00:00.000Z',
      changelog: 'Línea 1\n日本語 — ñ 😀\n\n"quoted" <b>',
    });
    expect(Buffer.from(message).toString('hex')).toBe(
      '696e6d6f6c696e6b2d77702d706c7567696e2f76320a353a312e322e332c36343a616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261622c333a362e342c333a382e312c333a362e382c32343a323032362d31302d32335431303a30303a30302e3030305a2c34343a4cc3ad6e656120310ae697a5e69cace8aa9e20e2809420c3b120f09f98800a0a2271756f74656422203c623e2c',
    );
    const spki = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from('A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=', 'base64'),
    ]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    expect(
      verify(
        null,
        Buffer.from(message),
        key,
        Buffer.from(
          'A/d4bTu14ziH7t81U4xMWluxqxCYajJ99lvpQt8Dmf5KWViQk9W14vgbHvm30CIlOpYU5WX250lHeclkXcBdAQ==',
          'base64',
        ),
      ),
    ).toBe(true);
  });

  it('[S9-F3] a value cannot shift into the next field (netstring framing)', () => {
    const base = {
      version: '1.0.0',
      sha256: 'a'.repeat(64),
      requires: '6.4',
      requiresPhp: '8.1',
      tested: '6.8',
      releasedAt: '2026-10-23T10:00:00.000Z',
      changelog: '',
    };
    expect(pluginSigningMessage({ ...base, tested: '6.8,3:x', changelog: '' })).not.toBe(
      pluginSigningMessage({ ...base, tested: '6.8', changelog: 'x' }),
    );
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
