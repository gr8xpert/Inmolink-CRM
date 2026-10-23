import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  PLUGIN_PACKAGE_MAX_BYTES,
  PluginReleaseManifest,
  type PluginUpdateInfo,
  pluginSigningMessage,
} from '@inmolink/contracts';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { type ObjectStore, type PutCondition, storage } from '@inmolink/platform/storage';

/**
 * WordPress plugin update server (S8-05, PLAN §9.4). Platform-wide and tenant-less (the same release for every site),
 * so its functions take no `ctx`: nothing here reads a tenant's data.
 *
 * Releases live in the bucket feed-api already reads (`feeds`, under `wp-plugin/`; the per-site feed sweep only touches
 * `site-feeds/`): `wp-plugin/<version>/inmolink.zip` (immutable), `wp-plugin/<version>/release.json` and
 * `wp-plugin/latest.json` (written last, so it never points at a missing package).
 */

export const PLUGIN_RELEASE_BUCKET = 'feeds' as const;
export const PLUGIN_LATEST_KEY = 'wp-plugin/latest.json';
/** How long a feed-api process keeps the latest manifest (seconds): a release reaches sites within a minute. */
export const PLUGIN_RELEASE_CACHE_SECONDS = 60;
export const PLUGIN_PACKAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const MANIFEST_MAX_BYTES = 64 * 1024;

export function pluginReleaseKeys(version: string): { zip: string; manifest: string } {
  return { zip: `wp-plugin/${version}/inmolink.zip`, manifest: `wp-plugin/${version}/release.json` };
}

let latest: { at: number; info: PluginUpdateInfo | null } | null = null;

/** Forgets the cached manifest (tests, or right after a publish in the same process). */
export function resetPluginReleaseCache(): void {
  latest = null;
  unknownVersions.clear();
}

/** Versions with no release, with the time they were found missing: made-up versions cost one storage read a minute. */
const unknownVersions = new Map<string, number>();
const UNKNOWN_VERSIONS_MAX = 1_000;

/** A stored manifest, or null when it is not valid JSON in the manifest shape (an operator error: "no release"). */
function parseManifest(raw: Uint8Array | null): PluginReleaseManifest | null {
  if (raw === null) return null;
  try {
    const parsed = PluginReleaseManifest.safeParse(JSON.parse(new TextDecoder().decode(raw)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function readManifest(key: string): Promise<PluginReleaseManifest | null> {
  return parseManifest(await storage().get(PLUGIN_RELEASE_BUCKET, key, { maxBytes: MANIFEST_MAX_BYTES }));
}

function toInfo(m: PluginReleaseManifest): PluginUpdateInfo {
  const { commit: _commit, ...rest } = m;
  return { ...rest, package: `/v2/plugin/package/${m.version}` };
}

/** `GET /v2/plugin/update`: the latest release (one storage read per process per minute). */
export async function latestPluginRelease(): Promise<PluginUpdateInfo> {
  const now = clock.nowMs();
  if (!latest || now - latest.at >= PLUGIN_RELEASE_CACHE_SECONDS * 1000) {
    const manifest = await readManifest(PLUGIN_LATEST_KEY);
    // A miss is cached too: every site's update check would otherwise read storage.
    latest = { at: now, info: manifest ? toInfo(manifest) : null };
  }
  if (!latest.info) throw new AppError('PLUGIN_RELEASE_NOT_FOUND');
  return latest.info;
}

/** `GET /v2/plugin/package/{version}`: the release's zip as a stream, with its manifest (ETag = SHA-256). */
export async function pluginPackage(version: string): Promise<{ manifest: PluginReleaseManifest; body: Readable }> {
  const keys = pluginReleaseKeys(version);
  const now = clock.nowMs();
  const missedAt = unknownVersions.get(version);
  if (missedAt !== undefined && now - missedAt < PLUGIN_RELEASE_CACHE_SECONDS * 1000) {
    throw new AppError('PLUGIN_RELEASE_NOT_FOUND');
  }
  const manifest = await readManifest(keys.manifest);
  if (!manifest || manifest.version !== version) {
    if (unknownVersions.size >= UNKNOWN_VERSIONS_MAX) unknownVersions.clear();
    unknownVersions.set(version, now);
    throw new AppError('PLUGIN_RELEASE_NOT_FOUND');
  }
  const body = await storage().getStream(PLUGIN_RELEASE_BUCKET, keys.zip, { maxBytes: PLUGIN_PACKAGE_MAX_BYTES });
  if (!body) throw new AppError('PLUGIN_RELEASE_NOT_FOUND');
  return { manifest, body };
}

export interface PluginReleaseInput {
  version: string;
  requires: string;
  requiresPhp: string;
  tested: string;
  commit: string;
  changelog?: string;
}

/**
 * Publishes a release (the release script): signs the zip, stores it and its manifest, then points `latest.json` at
 * it. A version is immutable: publishing it again with other bytes fails; the same bytes only re-point `latest`.
 * `latest.json` never moves backwards (a lower version is stored but not offered).
 *
 * @param sign Ed25519 signature of a message (the private key stays with the caller).
 */
export async function publishPluginRelease(
  store: ObjectStore,
  zip: Uint8Array,
  input: PluginReleaseInput,
  sign: (message: Uint8Array) => Uint8Array,
): Promise<PluginReleaseManifest> {
  if (zip.byteLength === 0 || zip.byteLength > PLUGIN_PACKAGE_MAX_BYTES) {
    throw new Error(`plugin zip must be 1 byte to ${PLUGIN_PACKAGE_MAX_BYTES} bytes`);
  }
  const sha256 = createHash('sha256').update(zip).digest('hex');
  // The signature covers the metadata WordPress shows too (S9-F3), so everything is fixed before signing.
  const unsigned = PluginReleaseManifest.omit({ signature: true }).parse({
    slug: 'inmolink',
    version: input.version,
    sha256,
    sizeBytes: zip.byteLength,
    requires: input.requires,
    requiresPhp: input.requiresPhp,
    tested: input.tested,
    releasedAt: clock.now().toISOString(),
    commit: input.commit,
    changelog: input.changelog ?? '',
  });
  const signature = Buffer.from(sign(new TextEncoder().encode(pluginSigningMessage(unsigned)))).toString('base64');
  const manifest = PluginReleaseManifest.parse({ ...unsigned, signature });

  const keys = pluginReleaseKeys(manifest.version);
  const existingRaw = await store.get(PLUGIN_RELEASE_BUCKET, keys.manifest, { maxBytes: MANIFEST_MAX_BYTES });
  const existing = parseManifest(existingRaw);
  if (existingRaw !== null && existing === null) {
    throw new Error(`version ${manifest.version} has an unreadable release.json; fix it by hand, never overwrite`);
  }
  if (existing === null && (await store.head(PLUGIN_RELEASE_BUCKET, keys.zip)) !== null) {
    throw new Error(`version ${manifest.version} has a zip but no release.json; fix it by hand, never overwrite`);
  }
  // The same commit may zip to other bytes with another git version: it is the same release, kept as published.
  if (existing && existing.sha256 !== sha256 && existing.commit !== manifest.commit) {
    throw new Error(`version ${manifest.version} is already published with other bytes; bump the version`);
  }
  const stored = existing ?? manifest;
  if (!existing) {
    await store.put(PLUGIN_RELEASE_BUCKET, keys.zip, zip, {
      contentType: 'application/zip',
      cacheControl: PLUGIN_PACKAGE_CACHE_CONTROL,
    });
    await store.put(PLUGIN_RELEASE_BUCKET, keys.manifest, new TextEncoder().encode(JSON.stringify(stored)), {
      contentType: 'application/json',
    });
  }

  await pointLatestAt(store, stored);
  return stored;
}

/** Attempts at the compare-and-set of `latest.json` before giving up (each retry means another release won the race). */
const LATEST_ATTEMPTS = 8;

/**
 * Moves `latest.json` to `release` unless it already names a higher version (S8-F30). Two releases running at once
 * cannot lose the higher one: each write is conditional on the ETag of the `latest.json` it compared against (or on
 * its absence), and a lost race re-reads and compares again.
 */
async function pointLatestAt(store: ObjectStore, release: PluginReleaseManifest): Promise<void> {
  const body = new TextEncoder().encode(JSON.stringify(release));
  for (let attempt = 0; attempt < LATEST_ATTEMPTS; attempt++) {
    // Head before get: the content read is at least as new as the ETag the write is conditional on.
    const head = await store.head(PLUGIN_RELEASE_BUCKET, PLUGIN_LATEST_KEY);
    const raw = head
      ? await store.get(PLUGIN_RELEASE_BUCKET, PLUGIN_LATEST_KEY, { maxBytes: MANIFEST_MAX_BYTES })
      : null;
    const current = parseManifest(raw);
    if (current && compareVersions(release.version, current.version) < 0) return;
    const condition: PutCondition = head ? { ifMatch: head.etag } : { ifNoneMatch: '*' };
    const written = await store.putIf(
      PLUGIN_RELEASE_BUCKET,
      PLUGIN_LATEST_KEY,
      body,
      { contentType: 'application/json', cacheControl: 'no-cache' },
      condition,
    );
    if (written) return;
  }
  throw new Error(`latest.json kept changing under ${release.version}; run the release again`);
}

/** `major.minor.patch` comparison (-1, 0, 1). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
