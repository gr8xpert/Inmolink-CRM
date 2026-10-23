/** plugin-updates — public API (PATTERNS §1): the WordPress plugin's update server (S8-05). */

export { pluginUpdatesErrors } from './errors';
export {
  latestPluginRelease,
  PLUGIN_LATEST_KEY,
  PLUGIN_RELEASE_CACHE_SECONDS,
  pluginPackage,
  pluginReleaseKeys,
  publishPluginRelease,
  resetPluginReleaseCache,
} from './service';
