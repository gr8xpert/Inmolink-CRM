/**
 * exports — public API (PATTERNS §1). The only import path for other modules and apps. S10-F1: only what code outside
 * the module uses (checked by `__tests__/public-surface.test.ts`); worker-side code (`app_system`, a `tx` and no
 * `ctx`) is behind the worker-only entry (`./worker`), and the module's own tests import internals directly.
 */
export { configureExports } from './config';
export { exportsErrors } from './errors';
export { exportsEvents } from './events';
export { CLIENT_MODE_ALLOWED, can, EXPORTS_ACTIONS, EXPORTS_IMPERSONATION } from './policy';
export { PORTAL_FEED_STALE_IF_ERROR, PORTAL_FEED_TTL, portalFeedFile, portalFeedPrefix } from './serve';
export {
  createConnection,
  deleteConnection,
  getConnection,
  listChannels,
  listConnections,
  listFeedRuns,
  listIssues,
  listOverrides,
  PORTAL_CHANNEL_CATALOG,
  previewSelection,
  revokeConnectionToken,
  rotateConnectionToken,
  setOverrides,
  syncPortalChannels,
  updateConnection,
} from './service';
