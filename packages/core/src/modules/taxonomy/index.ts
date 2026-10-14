/** taxonomy — public API (PATTERNS §1). The only import path for other modules and apps. */
export { taxonomyErrors } from './errors';
export { taxonomyEvents } from './events';
export { taxonomyJobs } from './jobs';
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
  resolveFeatureAlias,
  resolveLocationAlias,
  resolvePropertyTypeAlias,
} from './service';
