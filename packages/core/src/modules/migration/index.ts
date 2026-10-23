/** migration — public API (PATTERNS §1). The only import path for other modules and apps. */
export { migrationErrors } from './errors';
export { migrationEvents } from './events';
export { migrationJobs } from './jobs';
export {
  LEGACY_TAXONOMY_MAX_ROWS,
  LEGACY_TAXONOMY_REFRESH_MS,
  type LegacyEntity,
  type LegacyTaxonomy,
  legacyIdsQuery,
  legacyTarget,
  legacyTaxonomy,
  reloadLegacyTaxonomy,
  resetLegacyIdCache,
  resetLegacyTaxonomy,
} from './legacy-ids';
export { type ImportOptions, importLegacyTaxonomy } from './service';
