import { z } from 'zod';

/**
 * WordPress plugin updates (S8-05, PLAN §9.4): the plugin's own update server. A release is a zip plus a manifest in
 * the feeds bucket (`wp-plugin/<version>/inmolink.zip`, `wp-plugin/latest.json`), published by
 * `pnpm ops:wp-plugin-release`. Every package is signed with Ed25519; the plugin pins the public key and verifies the
 * signature over {@link pluginSigningMessage} before WordPress unpacks anything.
 */

/** A plugin version: `major.minor.patch` (WordPress compares them with `version_compare`). */
export const PluginVersion = z.string().regex(/^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/);
export type PluginVersion = z.infer<typeof PluginVersion>;

/** A WordPress or PHP version requirement (`6.4`, `8.1`, `6.8.3`). */
const RequiredVersion = z.string().regex(/^\d{1,2}\.\d{1,2}(\.\d{1,2})?$/);

/** The release manifest as stored (`wp-plugin/latest.json` and `wp-plugin/<version>/release.json`). */
export const PluginReleaseManifest = z.strictObject({
  slug: z.literal('inmolink'),
  version: PluginVersion,
  /** SHA-256 of the zip, lower-case hex. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Ed25519 signature over `pluginSigningMessage(version, sha256)`, base64 (64 bytes). */
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  sizeBytes: z.number().int().positive(),
  requires: RequiredVersion,
  requiresPhp: RequiredVersion,
  tested: RequiredVersion,
  releasedAt: z.iso.datetime(),
  /** The commit the zip was built from. */
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  /** Release notes, plain text (the plugin escapes them). */
  changelog: z.string().max(4_000).default(''),
});
export type PluginReleaseManifest = z.infer<typeof PluginReleaseManifest>;

/** `GET /v2/plugin/update`: the latest release, with the package path relative to the API base. */
export const PluginUpdateInfo = PluginReleaseManifest.omit({ commit: true }).extend({
  /** `/v2/plugin/package/<version>` — resolved against the API base the plugin uses. */
  package: z.string().regex(/^\/v2\/plugin\/package\/\d+\.\d+\.\d+$/),
});
export type PluginUpdateInfo = z.infer<typeof PluginUpdateInfo>;

/** `GET /v2/plugin/package/{version}`. */
export const PluginPackageParams = z.strictObject({ version: PluginVersion });
export type PluginPackageParams = z.infer<typeof PluginPackageParams>;

/** Largest plugin zip the update server stores or serves. */
export const PLUGIN_PACKAGE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * The bytes a release signature covers: the slug, the version and the zip's SHA-256 — so a signed package can never be
 * replayed as another version (a downgrade) or another plugin. The PHP updater builds the same string.
 */
export function pluginSigningMessage(version: string, sha256: string): string {
  return `inmolink-wp-plugin\n${version}\n${sha256}`;
}
