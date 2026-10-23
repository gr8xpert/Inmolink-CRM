// pnpm ops:wp-plugin-release [--local [--test]] [--dry-run <dir>] [--changelog "…"]
//
// Releases the WordPress plugin (S8-05): builds `inmolink.zip` from the committed `apps/wp-plugin` (git archive of
// HEAD, so the zip stands for a commit; dev files excluded), signs it with Ed25519 over
// `pluginSigningMessage(...)` (version, SHA-256, requirements, releasedAt, changelog) and publishes it through the storage adapter to the feeds bucket
// (`wp-plugin/<version>/inmolink.zip`, `release.json`, then `latest.json`), where feed-api's update server
// (`/v2/plugin/update`, `/v2/plugin/package/<version>`) serves it. A version is immutable: bump `Version:` and
// `VERSION` in apps/wp-plugin/inmolink.php first. Refuses a working tree with uncommitted changes.
//
// Env: INMOLINK_PLUGIN_SIGNING_KEY — the Ed25519 private key, base64 of its 32-byte seed (or of libsodium's 64-byte
// secret key); never in the repo (HUMAN-ACTIONS H18). The storage section (S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID,
// S3_SECRET_ACCESS_KEY, S3_BUCKET_*, S3_BUCKET_FEEDS) with a token that may write the feeds bucket. `--local` reads the
// local stack's env file instead; `--dry-run <dir>` writes the zip and manifest there and uploads nothing. The key must
// match `Updater::PUBLIC_KEY` in the released commit (else every site would refuse the package); one release at a time.
import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, type KeyObject, sign } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { PluginReleaseManifest } from '@inmolink/contracts';
import { publishPluginRelease } from '@inmolink/core/modules/plugin-updates';
import { loadConfigOrExit, storageEnv } from '@inmolink/platform/config';
import { createMemoryStore, createS3Store, type ObjectStore, storageConfigFromEnv } from '@inmolink/platform/storage';
import { readStackEnv } from './stack-env';

const ROOT = join(import.meta.dirname, '../..');
const PLUGIN_DIR = 'apps/wp-plugin';
/** Development files that never ship. */
export const PLUGIN_EXCLUDES = [
  'tests',
  'docker',
  'composer.json',
  'composer.lock',
  'phpunit.xml.dist',
  'phpcs.xml.dist',
  'docker-compose.test.yml',
  '.gitignore',
  '.dockerignore',
];
/** PKCS#8 DER prefix of an Ed25519 private key; the 32-byte seed follows. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

/** The plugin zip of a commit: `inmolink/…` entries, dev files excluded. */
export function buildPluginZip(commit = 'HEAD'): Uint8Array {
  const out = execFileSync(
    'git',
    [
      'archive',
      '--format=zip',
      '--prefix=inmolink/',
      `${commit}:${PLUGIN_DIR}`,
      '--',
      '.',
      ...PLUGIN_EXCLUDES.map((p) => `:(exclude)${p}`),
    ],
    { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
  );
  return new Uint8Array(out);
}

/** Version and requirements from the main plugin file's header (and the `VERSION` constant, which must agree). */
export function pluginHeader(php: string): { version: string; requires: string; requiresPhp: string; tested: string } {
  const field = (name: string) => {
    const m = new RegExp(`^\\s*\\*\\s*${name}:\\s*(\\S+)\\s*$`, 'm').exec(php);
    if (!m?.[1]) throw new Error(`inmolink.php: no "${name}:" header`);
    return m[1];
  };
  const version = field('Version');
  const constant = /const VERSION\s*=\s*'([^']+)'/.exec(php)?.[1];
  if (constant !== version) throw new Error(`inmolink.php: Version ${version} and VERSION ${constant} differ`);
  return {
    version,
    requires: field('Requires at least'),
    requiresPhp: field('Requires PHP'),
    tested: field('Tested up to'),
  };
}

/** The signing key from its base64 form: a 32-byte seed or libsodium's 64-byte secret key (seed + public key). */
export function signingKey(base64: string): KeyObject {
  const raw = Buffer.from(base64.trim(), 'base64');
  if (raw.length !== 32 && raw.length !== 64) throw new Error('INMOLINK_PLUGIN_SIGNING_KEY: expected 32 or 64 bytes');
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, raw.subarray(0, 32)]),
    format: 'der',
    type: 'pkcs8',
  });
  if (raw.length === 64) {
    const pub = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
    if (!pub.equals(raw.subarray(32))) throw new Error('INMOLINK_PLUGIN_SIGNING_KEY: public half does not match');
  }
  return key;
}

/** The raw 32-byte public key (base64) to pin in the plugin (`Updater::PUBLIC_KEY`). */
export function publicKeyBase64(key: KeyObject): string {
  return createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
}

/** The public key pinned in `Updater::PUBLIC_KEY` of a commit's Updater.php ('' when none). */
export function pinnedPublicKey(updaterPhp: string): string {
  return /const PUBLIC_KEY\s*=\s*'([A-Za-z0-9+/=]*)'/.exec(updaterPhp)?.[1] ?? '';
}

/** Builds, signs and publishes the release of `commit` to `store`. */
export async function releasePlugin(
  store: ObjectStore,
  key: KeyObject,
  /** `php`: the main plugin file's source (defaults to the commit's). */
  opts: { commit: string; changelog?: string; php?: string },
): Promise<{ manifest: PluginReleaseManifest; zip: Uint8Array }> {
  const header = pluginHeader(opts.php ?? git('show', `${opts.commit}:${PLUGIN_DIR}/inmolink.php`));
  const zip = buildPluginZip(opts.commit);
  const manifest = await publishPluginRelease(
    store,
    zip,
    { ...header, commit: git('rev-parse', opts.commit), changelog: opts.changelog },
    (message) => new Uint8Array(sign(null, message, key)),
  );
  return { manifest, zip };
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const { values } = parseArgs({
    options: {
      local: { type: 'boolean', default: false },
      test: { type: 'boolean', default: false },
      'dry-run': { type: 'string' },
      changelog: { type: 'string', default: '' },
      'allow-unpinned': { type: 'boolean', default: false },
    },
  });
  if (git('status', '--porcelain', '--untracked-files=no') !== '') {
    process.stderr.write(
      'ops:wp-plugin-release: the working tree has uncommitted changes; commit or stash them first\n',
    );
    process.exit(1);
  }
  const secret = process.env.INMOLINK_PLUGIN_SIGNING_KEY;
  if (!secret) {
    process.stderr.write('ops:wp-plugin-release: INMOLINK_PLUGIN_SIGNING_KEY is not set (HUMAN-ACTIONS H18)\n');
    process.exit(1);
  }
  const key = signingKey(secret);
  const commit = git('rev-parse', 'HEAD');
  const pinned = pinnedPublicKey(git('show', `${commit}:${PLUGIN_DIR}/src/Updates/Updater.php`));
  if (pinned !== publicKeyBase64(key) && !(pinned === '' && values['allow-unpinned'])) {
    process.stderr.write(
      pinned === ''
        ? `ops:wp-plugin-release: no public key is pinned in Updater::PUBLIC_KEY — sites would refuse this release. Pin ${publicKeyBase64(key)} and commit (or --allow-unpinned for a staging dry run)\n`
        : 'ops:wp-plugin-release: INMOLINK_PLUGIN_SIGNING_KEY does not match Updater::PUBLIC_KEY — sites would refuse this release\n',
    );
    process.exit(1);
  }
  const dryRun = values['dry-run'];
  let store: ObjectStore;
  if (dryRun) {
    store = createMemoryStore();
  } else {
    if (values.local) {
      for (const [k, v] of Object.entries(readStackEnv(values.test ? 'test' : 'dev'))) process.env[k] ??= v;
    }
    store = createS3Store(storageConfigFromEnv(loadConfigOrExit({ ...storageEnv })));
  }
  const { manifest, zip } = await releasePlugin(store, key, { commit, changelog: values.changelog });
  if (dryRun) {
    mkdirSync(dryRun, { recursive: true });
    writeFileSync(join(dryRun, `inmolink-${manifest.version}.zip`), zip);
    writeFileSync(join(dryRun, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  process.stdout.write(
    `${JSON.stringify({ ...manifest, publicKey: publicKeyBase64(key), dryRun: Boolean(dryRun) }, null, 2)}\n`,
  );
}
