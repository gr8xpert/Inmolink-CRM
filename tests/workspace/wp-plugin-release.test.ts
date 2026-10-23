import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { pluginSigningMessage } from '@inmolink/contracts';
import { PLUGIN_LATEST_KEY, pluginReleaseKeys } from '@inmolink/core/modules/plugin-updates';
import { createMemoryStore } from '@inmolink/platform/storage';
import { describe, expect, it } from 'vitest';
import {
  buildPluginZip,
  deterministicZip,
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
      Buffer.from(pluginSigningMessage(manifest)),
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

  it('[S8-F30] the same commit zipped twice is byte-identical, whatever the order, modes or clock', () => {
    const a = buildPluginZip('HEAD');
    const b = buildPluginZip('HEAD');
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);

    const files = [
      { path: 'inmolink/b.php', data: new TextEncoder().encode('<?php // b') },
      { path: 'inmolink/a.php', data: new TextEncoder().encode('<?php // a') },
      { path: 'inmolink/src/c.php', data: new TextEncoder().encode('<?php // c') },
    ];
    const sorted = deterministicZip(files);
    expect(Buffer.from(deterministicZip([...files].reverse())).equals(Buffer.from(sorted))).toBe(true);
    expect(zipEntries(sorted)).toEqual(['inmolink/a.php', 'inmolink/b.php', 'inmolink/src/c.php']);

    // Fixed attributes: 1980-01-01 00:00, Unix -rw-r--r--, no extra field, no comment.
    const buf = Buffer.from(sorted);
    for (let i = buf.indexOf('PK\x01\x02'); i !== -1; i = buf.indexOf('PK\x01\x02', i + 4)) {
      expect(buf.readUInt16LE(i + 12)).toBe(0);
      expect(buf.readUInt16LE(i + 14)).toBe(0x21);
      expect(buf.readUInt32LE(i + 38) >>> 16).toBe(0o100644);
      expect(buf.readUInt16LE(i + 30)).toBe(0);
      expect(buf.readUInt16LE(i + 32)).toBe(0);
    }
  });

  it('[S8-F30] the reproducible zip holds the committed bytes of each file', () => {
    const buf = Buffer.from(buildPluginZip('HEAD'));
    const at = buf.indexOf('PK\x01\x02');
    expect(at).toBeGreaterThan(0);
    // The first local entry is inmolink/ + the alphabetically first file; compare the main plugin file instead.
    for (let i = buf.indexOf('PK\x03\x04'); i !== -1; i = buf.indexOf('PK\x03\x04', i + 4)) {
      const nameLen = buf.readUInt16LE(i + 26);
      const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
      if (name !== 'inmolink/inmolink.php') continue;
      const start = i + 30 + nameLen;
      const data = inflateRawSync(buf.subarray(start, start + buf.readUInt32LE(i + 18)));
      const committed = execFileSync('git', ['show', 'HEAD:apps/wp-plugin/inmolink.php'], {
        cwd: join(import.meta.dirname, '../..'),
        maxBuffer: 16 * 1024 * 1024,
      });
      expect(data.equals(committed)).toBe(true);
      return;
    }
    throw new Error('inmolink/inmolink.php is not in the zip');
  });
});
