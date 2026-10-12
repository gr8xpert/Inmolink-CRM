/**
 * dashboard — what the signed-in dashboard may show (S1-10). Aggregates the other modules' policies
 * through their index.ts and owns no tables, so identity and agencies stay leaves; a module that adds a
 * dashboard section registers it here.
 */
export { getMyCapabilities } from './capabilities';
export { dashboardEvents } from './events';
