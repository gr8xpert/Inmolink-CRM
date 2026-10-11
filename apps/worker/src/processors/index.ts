import { identityJobs } from '@inmolink/core/modules/identity';
import type { JobDef } from '@inmolink/platform/queue';
import type { Pool } from '../config';

/**
 * Jobs per pool. Each module's `jobs.ts` owns its handlers (PATTERNS §12); a pool's entry only lists
 * them, e.g. `indexing: [searchJobs.reindexListing]`. The `outbox` pool runs the dispatcher instead.
 * Pools stay empty until their first module lands.
 */
export const POOL_JOBS: Record<Exclude<Pool, 'outbox'>, readonly JobDef[]> = {
  imports: [],
  media: [],
  indexing: [],
  matching: [],
  exports: [],
  email: [identityJobs.sendAuthEmail, identityJobs.sendInviteEmail, identityJobs.sendVerificationDecisionEmail],
  ai: [],
  social: [],
  pdf: [],
  maintenance: [],
};
