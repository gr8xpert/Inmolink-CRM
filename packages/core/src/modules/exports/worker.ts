/**
 * exports — worker-only entry (`@inmolink/core/modules/exports/worker`, S9-02). The feed writer reads every agency's
 * tables as `app_system` (`withSystem`), so it is not part of the module's public `index.ts` that the dashboard API
 * imports: only `apps/worker` (the generator job, S9-03), tests and scripts may import this file
 * (`core-module-worker-entry-workers-only`, `.dependency-cruiser.cjs`).
 */
export {
  buildItems,
  FEED_BATCH,
  type PortalFeedOptions,
  type PortalFeedResult,
  writeConnectionFeed,
} from './feed';
