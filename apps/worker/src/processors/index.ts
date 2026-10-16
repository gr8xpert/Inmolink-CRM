import { agenciesJobs } from '@inmolink/core/modules/agencies';
import { complianceJobs } from '@inmolink/core/modules/compliance';
import { identityJobs } from '@inmolink/core/modules/identity';
import { mediaDocumentJobs, mediaJobs } from '@inmolink/core/modules/media';
import { propertiesJobs } from '@inmolink/core/modules/properties';
import { qualityJobs } from '@inmolink/core/modules/quality';
import type { JobDef } from '@inmolink/platform/queue';
import type { Pool } from '../config';

/**
 * Jobs per pool. Each module's `jobs.ts` owns its handlers (PATTERNS §12); a pool's entry only lists
 * them, e.g. `indexing: [searchJobs.reindexListing]`. The `outbox` pool runs the dispatcher instead.
 * Pools stay empty until their first module lands.
 */
export const POOL_JOBS: Record<Exclude<Pool, 'outbox'>, readonly JobDef[]> = {
  imports: [propertiesJobs.runBulkAction],
  media: [mediaJobs.syncObjects, mediaJobs.processObject, mediaJobs.pruneOrphans, mediaJobs.reprocessStale],
  indexing: [qualityJobs.recomputeListing],
  matching: [],
  exports: [],
  email: [
    identityJobs.sendAuthEmail,
    identityJobs.sendInviteEmail,
    identityJobs.sendTwoFactorNotice,
    identityJobs.sendVerificationDecisionEmail,
  ],
  maintenance: [
    identityJobs.pruneAuthTokens,
    identityJobs.flushApiKeyUsage,
    identityJobs.syncApiKeyAgencyStatus,
    agenciesJobs.pruneOrphanVerificationDocuments,
    complianceJobs.maintainPartitions,
    propertiesJobs.failStaleBulkActions,
    propertiesJobs.sweepFreshness,
    mediaDocumentJobs.deleteDocumentObject,
    mediaDocumentJobs.purgeDocuments,
    mediaDocumentJobs.sweepOrphanDocuments,
  ],
  ai: [],
  social: [],
  pdf: [],
};
