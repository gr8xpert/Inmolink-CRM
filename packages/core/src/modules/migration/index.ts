/** migration — public API (PATTERNS §1). The only import path for other modules and apps. */
export { migrationErrors } from './errors';
export { migrationEvents } from './events';
export { migrationJobs } from './jobs';
export {
  type LegacyTaxonomy,
  legacyIdsQuery,
  legacyTarget,
  legacyTaxonomy,
  reloadLegacyTaxonomy,
  resetLegacyIdCache,
} from './legacy-ids';
export { type ImportOptions, importLegacyTaxonomy } from './service';
