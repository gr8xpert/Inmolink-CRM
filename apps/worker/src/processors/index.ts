import { agenciesJobs } from '@inmolink/core/modules/agencies';
import { complianceJobs } from '@inmolink/core/modules/compliance';
import { developmentsJobs } from '@inmolink/core/modules/developments';
import { exportsJobs } from '@inmolink/core/modules/exports/worker';
import { identityJobs } from '@inmolink/core/modules/identity';
import { importsJobs } from '@inmolink/core/modules/imports';
import { mediaDocumentJobs, mediaJobs } from '@inmolink/core/modules/media';
import { propertiesJobs } from '@inmolink/core/modules/properties';
import { qualityJobs } from '@inmolink/core/modules/quality';
import { searchJobs } from '@inmolink/core/modules/search';
import { websiteApiJobs } from '@inmolink/core/modules/website-api';
import { websitesJobs } from '@inmolink/core/modules/websites';
import type { JobDef } from '@inmolink/platform/queue';
import type { Pool } from '../config';

/**
 * Jobs per pool. Each module's `jobs.ts` owns its handlers (PATTERNS §12); a pool's entry only lists
 * them, e.g. `indexing: [searchJobs.reindexListing]`. The `outbox` pool runs the dispatcher instead.
 * Pools stay empty until their first module lands.
 */
export const POOL_JOBS: Record<Exclude<Pool, 'outbox'>, readonly JobDef[]> = {
  imports: [
    importsJobs.runFeed,
    importsJobs.scheduleFeeds,
    propertiesJobs.runBulkAction,
    mediaJobs.importFeedImages,
    mediaJobs.sweepFeedImages,
  ],
  media: [mediaJobs.syncObjects, mediaJobs.processObject, mediaJobs.pruneOrphans, mediaJobs.reprocessStale],
  indexing: [
    qualityJobs.recomputeListings,
    qualityJobs.sweepQueue,
    qualityJobs.recomputeListing,
    searchJobs.buildReadModels,
    searchJobs.sweepReadModelQueue,
    searchJobs.buildDevelopmentReadModels,
    searchJobs.buildAgencyReadModels,
    searchJobs.syncIndex,
    searchJobs.checkIndexDrift,
    searchJobs.prunePublicChanges,
    searchJobs.repairIndex,
    // S7-06: purges the website API's edge cache when public listings, sites or keys change.
    websiteApiJobs.purgeEdgeCache,
  ],
  matching: [],
  // S7-07: per-site XML feeds (Kyero and generic) and their 15-minute refresh sweep; S9-03: portal feeds.
  exports: [
    websiteApiJobs.generateSiteFeed,
    websiteApiJobs.refreshSiteFeeds,
    websiteApiJobs.deleteSiteFeedFiles,
    websiteApiJobs.sweepNetworkFeeds,
    // S9-03: portal feeds — one pass per agency (events, nightly) and the nightly sweep.
    exportsJobs.generatePortalFeeds,
    exportsJobs.generateNightlyPortalFeeds,
    exportsJobs.sweepNightlyPortalFeeds,
  ],
  email: [
    identityJobs.sendAuthEmail,
    identityJobs.sendInviteEmail,
    identityJobs.sendTwoFactorNotice,
    identityJobs.sendVerificationDecisionEmail,
    websiteApiJobs.sendLeadAcknowledgement,
    websiteApiJobs.notifyLeadAgency,
    websiteApiJobs.notifyLeadRecipient,
  ],
  maintenance: [
    identityJobs.pruneAuthTokens,
    websitesJobs.pruneLeadIdempotency,
    identityJobs.flushApiKeyUsage,
    identityJobs.syncApiKeyAgencyStatus,
    agenciesJobs.pruneOrphanVerificationDocuments,
    complianceJobs.maintainPartitions,
    propertiesJobs.failStaleBulkActions,
    propertiesJobs.sweepFreshness,
    propertiesJobs.removeOverrides,
    mediaDocumentJobs.deleteDocumentObject,
    mediaDocumentJobs.purgeDocuments,
    mediaDocumentJobs.purgeDeletedListings,
    mediaDocumentJobs.sweepOrphanDocuments,
    developmentsJobs.deleteDocumentObject,
    developmentsJobs.sweepOrphanDocuments,
    developmentsJobs.purgeDeletedDevelopments,
    importsJobs.pruneRuns,
    // S7-F1: uploaded sheets — a released file is deleted, idle (30 days) and orphaned files are swept daily.
    importsJobs.deleteSheet,
    importsJobs.sweepSheets,
  ],
  ai: [],
  social: [],
  pdf: [],
};
