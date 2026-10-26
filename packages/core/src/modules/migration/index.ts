/** migration — public API (PATTERNS §1). The only import path for other modules and apps. */

export { type BatchRunOptions, type BatchStep, CHECKPOINT_MAX_ISSUES, runBatches, type StepOutcome } from './batches';
export {
  areaParity,
  CUTOVER,
  CUTOVER_STEPS,
  type CutoverConfirmation,
  type CutoverDto,
  CutoverError,
  CutoverPlanInput,
  type CutoverRunResult,
  type CutoverStep,
  dueCutovers,
  getCutover,
  type LegacyControl,
  legacyDnsReadiness,
  planCutover,
  type RollbackCutoverInput,
  type RunCutoverInput,
  registerLegacyControl,
  rollbackCutover,
  runCutover,
} from './cutover';
export {
  DELTA,
  deltaAgencies,
  type LegacyDeltaSource,
  type LegacyDeltaSourceFactory,
  type LegacyDeltaState,
  legacyDeltaSourceFactory,
  legacyDeltaState,
  markLegacyAgencyCutOver,
  type OpenedLegacyDeltaSource,
  registerLegacyDeltaSource,
  type SyncLegacyDeltaInput,
  type SyncLegacyDeltaResult,
  syncLegacyDelta,
} from './delta';
export { migrationErrors } from './errors';
export { migrationEvents } from './events';
export { migrationJobs } from './jobs';
export {
  fromRows,
  LEGACY_BATCH_ROWS,
  LEGACY_DEVELOPMENT_MAX_ROWS,
  LEGACY_STAGING,
  type LegacyStagingEntity,
  type MigrateLegacyAgencyInput,
  type MigrateLegacyAgencyResult,
  migrateLegacyAgency,
  type StagedSource,
} from './legacy-agency';
export {
  LEGACY_DEVELOPMENT_BATCH,
  LEGACY_DEVELOPMENT_ENTITIES,
  type LegacyTaxonomyTargets,
  type LoadLegacyDevelopmentsInput,
  loadDevelopmentsInto,
  loadLegacyDevelopments,
  transformLegacyDevelopments,
} from './legacy-developments';
export {
  type LegacyTaxonomy,
  legacyIdsQuery,
  legacyTarget,
  legacyTaxonomy,
  reloadLegacyTaxonomy,
  resetLegacyIdCache,
} from './legacy-ids';
export {
  assertIdent,
  configureLegacyDelta,
  DEFAULT_ENTITIES,
  type DeltaMode,
  type EntitySpec,
  type LegacyDeltaReader,
  type OpenDeltaOptions,
  openLegacyDeltaReader,
  qualified,
  scope,
  validateSpecs,
} from './legacy-reader';
export { agencyOfLegacy } from './legacy-rows';
export {
  addIssue,
  addWarning,
  agencyTargets,
  chunks,
  contentLocale,
  countOutcome,
  countsOf,
  dropCollisions,
  enumKey,
  failureOf,
  finishReport,
  inSavepoint,
  LegacyMigrationError,
  mergeInto,
  newLoadReport,
  type PlatformEntity,
  recordAgencyMaps,
  recordMaps,
  resolveLegacyAgency,
  slugify,
  type TenantEntity,
  targetsOf,
  validateRows,
} from './load';
export { canStaff as canStaffMigration, type MigrationStaffAction } from './policy';
export {
  type BuildRedirectsInput,
  type BuildRedirectsResult,
  buildRedirectRows,
  flushRedirectHits,
  type LegacyUrlEntry,
  type NormalizedLegacyUrl,
  normalizeLegacyUrl,
  pushRedirectHits,
  REDIRECT_HITS_PUSH_MS,
  REDIRECT_QUERY_KEYS,
  type RedirectRow,
  type RedirectSource,
  type ResolvedRedirect,
  resetRedirectCache,
  resolveLegacyRedirect,
  saveRedirects,
} from './redirects';
export { type ImportOptions, importLegacyTaxonomy } from './service';
export {
  compareContact,
  compareLead,
  compareListing,
  type FieldDiff,
  recordValidationReport,
  settleReport,
  VALIDATION_BATCH_ROWS,
  type ValidateLegacyAgencyInput,
  validateLegacyAgency,
} from './validate';
export { getValidationReport, listValidationReports } from './validation-reports';
