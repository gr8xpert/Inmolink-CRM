/** taxonomy — public API (PATTERNS §1). The only import path for other modules and apps. */

export {
  addStaffCatalogAlias,
  addStaffLocationAlias,
  createStaffLocation,
  getStaffCatalogItem,
  getStaffLocation,
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
export {
  FUZZY_ACCEPT,
  FUZZY_MARGIN,
  type Resolution,
  type ResolveHints,
  type ResolveInput,
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
  resolveFeatureAlias,
  resolveLocationAlias,
  resolvePropertyTypeAlias,
} from './service';
export { registerTaxonomySubscriptions, unregisterTaxonomySubscriptions } from './subscriptions';
export {
  getTaxonomy,
  getTaxonomyDocument,
  getWebsiteCatalog,
  getWebsiteLocationChildren,
  getWebsiteLocations,
  invalidateTaxonomyCache,
  type Serialized,
  TAXONOMY_CACHE_TAG,
  TAXONOMY_CACHE_TTL_SECONDS,
  type Tagged,
  taxonomyCacheKey,
} from './tree';
