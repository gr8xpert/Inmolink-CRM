import { agenciesJobs } from '@inmolink/core/modules/agencies';
import { complianceJobs } from '@inmolink/core/modules/compliance';
import { crmJobs } from '@inmolink/core/modules/crm';
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
import type { JobDef, PoolOptions } from '@inmolink/platform/queue';
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
    // S10-01: CSV / Excel contact imports.
    crmJobs.importContacts,
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
    // S10-04: the activity timeline's writers from outbox events (lead, merge, listing status).
    crmJobs.recordActivity,
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
    // S9-04: push portals (idealista, Fotocasa).
    exportsJobs.pushPortalListings,
  ],
  email: [
    identityJobs.sendAuthEmail,
    identityJobs.sendInviteEmail,
    identityJobs.sendTwoFactorNotice,
    identityJobs.sendVerificationDecisionEmail,
    websiteApiJobs.sendLeadAcknowledgement,
    websiteApiJobs.notifyLeadAgency,
    websiteApiJobs.notifyLeadRecipient,
    websiteApiJobs.notifyLeadAgencyFallback,
    // S10-02: website leads promoted to CRM leads (speed-to-lead: the inbox within seconds).
    crmJobs.promoteInboundLead,
    // S10-05: task reminder e-mails (one per claimed reminder).
    crmJobs.sendTaskReminder,
    // S10-06: calendar reminder e-mails (one per claimed member attendee).
    crmJobs.sendEventReminder,
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
    // S10-01: contact import uploads never started are expired daily.
    crmJobs.sweepContactImports,
    // S10-04: a purged listing leaves the activity timelines.
    crmJobs.forgetListingActivities,
    // S10-05: the minute-by-minute claim of reminders that came due.
    crmJobs.sweepTaskReminders,
    // S10-06: the minute-by-minute claim of calendar reminders that came.
    crmJobs.sweepEventReminders,
    // S10-07: a contact merge moves the seller of the agency's listings to the survivor.
    crmJobs.repointSellerListings,
  ],
  ai: [],
  social: [],
  pdf: [],
};

/**
 * Pool options over the defaults. `email` (S10-02): the speed-to-lead pool's one group-capped job is
 * `crm.promoteInboundLead` (one per agency at a time); a lead waiting for its agency's previous one re-polls within
 * 1 s instead of backing off to 5 s (+ jitter), so a burst of one agency's leads stays inside the 10 s target.
 */
export const POOL_OPTIONS: Partial<Record<Exclude<Pool, 'outbox'>, PoolOptions>> = {
  email: { groupRetryMs: 100, groupRetryMaxMs: 1_000 },
};
