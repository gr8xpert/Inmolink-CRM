/** taxonomy — public API (PATTERNS §1). The only import path for other modules and apps. */
export { taxonomyErrors } from './errors';
export { taxonomyEvents } from './events';
export { taxonomyJobs } from './jobs';
export {
  addLocationAlias,
  aliasKey,
  createLocation,
  createLocationGroup,
  findLocationAtPoint,
  resolveLocationAlias,
} from './service';
