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
  /** Ed25519 signature over `pluginSigningMessage(...)` (the package and its metadata), base64 (64 bytes). */
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  sizeBytes: z.number().int().positive(),
  requires: RequiredVersion,
  requiresPhp: RequiredVersion,
  tested: RequiredVersion,
  releasedAt: z.iso.datetime(),
  /** The commit the zip was built from. */
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  /** Release notes, plain text (the plugin escapes them). */
  changelog: z
    .string()
    .max(4_000)
    .refine((s) => s.isWellFormed(), 'changelog must be well-formed Unicode')
    .default(''),
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

/** What a release signature covers (S9-F3): the update metadata WordPress shows, not only the package. */
export type PluginSigningFields = Pick<
  PluginReleaseManifest,
  'version' | 'sha256' | 'requires' | 'requiresPhp' | 'tested' | 'releasedAt' | 'changelog'
>;

/**
 * The bytes a release signature covers: the slug, the version, the zip's SHA-256, the requirements (`requires`,
 * `requiresPhp`, `tested`), `releasedAt` and the changelog, each as a netstring (`<UTF-8 byte length>:<value>,`) so no value can shift into another — so a signed
 * package can never be replayed as another version (a downgrade) or another plugin, and the metadata the update screen
 * shows cannot be altered by whoever serves it. The PHP updater (`Updater::signing_message`) builds the same string.
 */
export function pluginSigningMessage(f: PluginSigningFields): string {
  const field = (v: string) => `${new TextEncoder().encode(v).length}:${v},`;
  return `inmolink-wp-plugin/v2\n${[f.version, f.sha256, f.requires, f.requiresPhp, f.tested, f.releasedAt, f.changelog]
    .map(field)
    .join('')}`;
}
