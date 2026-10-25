/** taxonomy — public API (PATTERNS §1). The only import path for other modules and apps. */

export {
  addStaffCatalogAlias,
  addStaffLocationAlias,
  countStaffUnmatched,
  createStaffLocation,
  getStaffCatalogItem,
  getStaffLocation,
  getStaffLocationChildren,
  getStaffTaxonomy,
  ignoreStaffUnmatched,
  listStaffUnmatched,
  mapStaffUnmatched,
  removeStaffCatalogAlias,
  removeStaffLocationAlias,
  reorderStaffCatalog,
  reorderStaffLocations,
  updateStaffCatalogItem,
  updateStaffLocation,
} from './admin';
export { taxonomyErrors } from './errors';
export { TAXONOMY_ENTITIES, type TaxonomyEntity, taxonomyEvents } from './events';
export { taxonomyJobs } from './jobs';
export { type ReadModelTaxonomy, taxonName, taxonomyForReadModels } from './read-models';
/** The resolver's statements as built SQL, for the scale plan check (`tests/perf`), never for running queries. */
export {
  exactMatchesSql,
  fuzzyMatchesSql,
  fuzzyThresholdSql,
  localizedLocationsSql,
} from './repo';
export {
  FUZZY_ACCEPT,
  FUZZY_MARGIN,
  type QueueEntry,
  queueUnmatched,
  type Resolution,
  type ResolveHints,
  type ResolveInput,
  type ResolveValue,
  resolveAndQueue,
  resolveFeature,
  resolveLocation,
  resolveMany,
  resolveType,
  type TaxonomyKind,
} from './resolver';
export {
  addFeatureAlias,
  addLocationAlias,
  addPropertyTypeAlias,
  aliasKey,
  createFeature,
  createFeatureGroup,
  createLocation,
  createLocationGroup,
  createPropertyType,
  createPropertyTypeGroup,
  findLocationAtPoint,
  importAliases,
  locationAncestors,
  locationLineage,
  locationLineages,
  propertyTypeExists,
  resolveFeatureAlias,
  resolveLocationAlias,
  resolvePropertyTypeAlias,
} from './service';
export { registerTaxonomySubscriptions, unregisterTaxonomySubscriptions } from './subscriptions';
export {
  buildLocationTree,
  CHILDREN_PAGE_BYTES,
  CHILDREN_PAGE_MAX,
  childrenPageJson,
  childrenPages,
  dropLocalTaxonomyCopies,
  getTaxonomy,
  getTaxonomyDocument,
  getWebsiteCatalog,
  getWebsiteFeatures,
  getWebsiteLocationChildren,
  getWebsiteLocations,
  getWebsiteTypes,
  invalidateTaxonomyCache,
  type Serialized,
  TAXONOMY_CACHE_TAG,
  TAXONOMY_CACHE_TTL_SECONDS,
  type Tagged,
  type TreeNode,
  taxonomyCacheKey,
} from './tree';
// S12-08: in-memory name lookups for AI search.
export { dropSearchVocabularyCopies, type SearchVocabulary, searchVocabulary } from './vocabulary';
