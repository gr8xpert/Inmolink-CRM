import { generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pluginSigningMessage } from '@inmolink/contracts';
import { PLUGIN_LATEST_KEY, pluginReleaseKeys } from '@inmolink/core/modules/plugin-updates';
import { createMemoryStore } from '@inmolink/platform/storage';
import { describe, expect, it } from 'vitest';
import {
  buildPluginZip,
  PLUGIN_EXCLUDES,
  pinnedPublicKey,
  pluginHeader,
  publicKeyBase64,
  releasePlugin,
  signingKey,
} from '../../scripts/ops/wp-plugin-release';

const PHP = readFileSync(join(import.meta.dirname, '../../apps/wp-plugin/inmolink.php'), 'utf8');

/** Entry names of a zip from its central directory (no zip library needed). */
function zipEntries(zip: Uint8Array): string[] {
  const buf = Buffer.from(zip);
  const names: string[] = [];
  for (let i = buf.indexOf('PK\x01\x02'); i !== -1; i = buf.indexOf('PK\x01\x02', i + 4)) {
    const len = buf.readUInt16LE(i + 28);
    names.push(buf.subarray(i + 46, i + 46 + len).toString('utf8'));
  }
  return names;
}

describe('WordPress plugin release (S8-05)', () => {
  it('[S8-05] the zip ships the plugin under inmolink/ without development files', () => {
    const entries = zipEntries(buildPluginZip('HEAD'));
    expect(entries).toContain('inmolink/inmolink.php');
    expect(entries.some((e) => e.startsWith('inmolink/src/'))).toBe(true);
    for (const excluded of PLUGIN_EXCLUDES) {
      expect(
        entries.some((e) => e === `inmolink/${excluded}` || e.startsWith(`inmolink/${excluded}/`)),
        excluded,
      ).toBe(false);
    }
  });

  it('[S8-05] the release key must match the key pinned in Updater.php', () => {
    expect(pinnedPublicKey("  public const PUBLIC_KEY      = 'AbC+/9=';")).toBe('AbC+/9=');
    expect(pinnedPublicKey("public const PUBLIC_KEY = '';")).toBe('');
    const updater = readFileSync(join(import.meta.dirname, '../../apps/wp-plugin/src/Updates/Updater.php'), 'utf8');
    expect(pinnedPublicKey(updater)).toMatch(/^([A-Za-z0-9+/]{43}=)?$/);
  });

  it('[S8-05] the header gives the version and requirements; Version and VERSION must agree', () => {
    expect(pluginHeader(PHP)).toMatchObject({ requires: '6.4', requiresPhp: '8.1', tested: '6.8' });
    expect(() => pluginHeader(PHP.replace(/const VERSION\s*=\s*'[^']+'/, "const VERSION = '9.9.9'"))).toThrow(/differ/);
  });

  it('[S8-05] a release is signed with the key from the environment (seed or libsodium form) and published', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
    const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const key = signingKey(seed.toString('base64'));
    expect(publicKeyBase64(signingKey(Buffer.concat([seed, pub]).toString('base64')))).toBe(pub.toString('base64'));
    expect(() => signingKey(Buffer.concat([seed, Buffer.alloc(32)]).toString('base64'))).toThrow(/does not match/);
    expect(() => signingKey('c2hvcnQ=')).toThrow(/32 or 64 bytes/);

    const store = createMemoryStore();
    const { manifest, zip } = await releasePlugin(store, key, { commit: 'HEAD', php: PHP, changelog: 'Notes' });
    const ok = verify(
      null,
      Buffer.from(pluginSigningMessage(manifest.version, manifest.sha256)),
      publicKey,
      Buffer.from(manifest.signature, 'base64'),
    );
    expect(ok).toBe(true);
    const stored = await store.get('feeds', pluginReleaseKeys(manifest.version).zip, { maxBytes: 1e8 });
    expect(Buffer.from(stored ?? []).equals(Buffer.from(zip))).toBe(true);
    const latest = JSON.parse(
      new TextDecoder().decode((await store.get('feeds', PLUGIN_LATEST_KEY, { maxBytes: 1e6 })) ?? new Uint8Array()),
    );
    expect(latest).toMatchObject({ version: manifest.version, changelog: 'Notes', sha256: manifest.sha256 });
  });
});
