/** plugin-updates — public API (PATTERNS §1): the WordPress plugin's update server (S8-05). */

export { pluginUpdatesErrors } from './errors';
export {
  compareVersions,
  latestPluginRelease,
  PLUGIN_LATEST_KEY,
  PLUGIN_PACKAGE_CACHE_CONTROL,
  PLUGIN_RELEASE_BUCKET,
  PLUGIN_RELEASE_CACHE_SECONDS,
  type PluginReleaseInput,
  pluginPackage,
  pluginReleaseKeys,
  publishPluginRelease,
  resetPluginReleaseCache,
} from './service';
