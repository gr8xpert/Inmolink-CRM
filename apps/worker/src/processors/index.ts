// S12-01: the AI gateway's usage and spend-mirror jobs.
import { aiJobs } from '@inmolink/core';
import { agenciesJobs } from '@inmolink/core/modules/agencies';
import { aiFeaturesJobs, whiteLabelJobs } from '@inmolink/core/modules/ai-features';
import { chatJobs } from '@inmolink/core/modules/chat';
import { complianceJobs } from '@inmolink/core/modules/compliance';
import { dataExportJobs } from '@inmolink/core/modules/compliance/worker';
import { crmJobs } from '@inmolink/core/modules/crm';
import { developmentsJobs } from '@inmolink/core/modules/developments';
import { exportsJobs } from '@inmolink/core/modules/exports/worker';
import { identityJobs } from '@inmolink/core/modules/identity';
import { importsJobs } from '@inmolink/core/modules/imports';
import { matchingJobs } from '@inmolink/core/modules/matching';
import { mediaDocumentJobs, mediaJobs } from '@inmolink/core/modules/media';
import { mlsJobs } from '@inmolink/core/modules/mls';
import { networkJobs } from '@inmolink/core/modules/network';
import { notificationsJobs } from '@inmolink/core/modules/notifications';
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
    // S11-F10: the pipeline report's and the response KPI's rollups, rebuilt from lead events (throttled).
    crmJobs.refreshStageCounts,
    crmJobs.refreshReportDay,
  ],
  // S11-05: network board posts to matching subscribers, buyer requests against the other agencies' listings.
  matching: [
    networkJobs.notifySubscribers,
    networkJobs.matchBuyerRequest,
    // S5-06: saved searches' alerts from the read models' changes, their short and daily digests, keys, prune, backfill.
    matchingJobs.matchListings,
    matchingJobs.sendAlerts,
    matchingJobs.sweepAlerts,
    matchingJobs.sweepDigests,
    matchingJobs.rekeyAgency,
    matchingJobs.sweepRekey,
    matchingJobs.pruneAlerts,
    matchingJobs.backfillListingStates,
  ],
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
    // S10-08: data exports (contacts, leads, listings, the account ZIP).
    dataExportJobs.runDataExport,
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
    // S10-08: the admins' alert when a data export is requested.
    dataExportJobs.notifyDataExport,
    dataExportJobs.sendDataExportNotice,
    // S10-05: task reminder e-mails (one per claimed reminder).
    crmJobs.sendTaskReminder,
    // S10-06: calendar reminder e-mails (one per claimed member attendee).
    crmJobs.sendEventReminder,
    // S11-03: viewing threads seated and closed (the live pushes run in `realtime`).
    chatJobs.seatViewingThread,
    chatJobs.closeViewingThread,
  ],
  // S11 review: live socket pushes, never behind mail or digests (delivery target: queue age p95 < 30 s, PLAN §9).
  realtime: [
    // S11-03: chat messages (and their notifications) and read receipts pushed live.
    chatJobs.deliverMessage,
    chatJobs.pushRead,
    // S11-04: in-app notifications pushed to the recipients' sockets.
    notificationsJobs.pushRealtime,
    // S12-F2: notifications raised after the commit — a lead assigned, an import connection paused.
    crmJobs.notifyLeadAssigned,
    importsJobs.notifyConnectionPaused,
  ],
  // S11 review: the 5-minute notification e-mail digests (S11-04), thousands at once after a broad network post.
  digest: [notificationsJobs.sendDigest],
  maintenance: [
    // S12-02: Listing Studio batch records past their retention are deleted daily.
    aiFeaturesJobs.pruneListingStudioBatches,
    identityJobs.pruneAuthTokens,
    // S11-05: network board posts past their expiry are closed every 15 minutes.
    networkJobs.closeExpiredPosts,
    networkJobs.closePostThreads,
    websitesJobs.pruneLeadIdempotency,
    identityJobs.flushApiKeyUsage,
    identityJobs.syncApiKeyAgencyStatus,
    agenciesJobs.pruneOrphanVerificationDocuments,
    complianceJobs.maintainPartitions,
    // S10-08: expired data export files are deleted daily.
    dataExportJobs.sweepDataExports,
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
    // S12-F6: the nightly full rebuild of the CRM stage counts (the day's deltas checked against `leads`).
    crmJobs.sweepStageCounts,
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
    // S11-F12: a contact erasure clears its activity bodies and the listings' seller link.
    crmJobs.eraseContactData,
    // S11-01: a contact merge moves the agency's client registrations to the survivor.
    mlsJobs.repointRegistrations,
    // S11-01: the client fingerprint rehash during an HMAC rotation window, and the fingerprints' retention.
    mlsJobs.scheduleFingerprintRehash,
    mlsJobs.rehashFingerprints,
    mlsJobs.pruneFingerprints,
    // S11-02: unanswered viewing proposals expire; each viewing request change notifies the other side.
    mlsJobs.expireViewingRequests,
    mlsJobs.notifyViewing,
  ],
  ai: [
    // S12-01: worker-path AI usage records whose first write failed (ADR 0008 #6a).
    aiJobs.retryUsageRecord,
    // S12-03: the white-label sanitizer's model pass over changed public documents.
    whiteLabelJobs.sanitizeTexts,
    // S12-02: the AI Listing Studio — one listing's drafts, and bulk drafts through the batch API.
    aiFeaturesJobs.generateListingCopy,
    aiFeaturesJobs.submitListingStudioBatch,
    aiFeaturesJobs.collectListingStudioBatch,
  ],
  social: [],
  pdf: [],
  // S12-01 (ADR 0018): request-path AI usage records and spend-mirror seeds, on their own queue — the only one
  // feed-api's `feed_ai` Redis user can write; the worker validates every record.
  'ai-usage': [aiJobs.recordUsage, aiJobs.refreshSpend],
};

/** Digests in flight per process (each one a database claim and one e-mail): the SMTP relay sets the pace, not slots. */
export const DIGEST_CONCURRENCY = 4;

/**
 * Pool options over the defaults. `email` (S10-02): the speed-to-lead pool's one group-capped job is
 * `crm.promoteInboundLead` (one per agency at a time); a lead waiting for its agency's previous one re-polls within
 * 1 s instead of backing off to 5 s (+ jitter), so a burst of one agency's leads stays inside the 10 s target.
 * `digest` (S11 review): its own slots per process, no per-process cap to bounce off — a burst waits in its queue.
 */
export const POOL_OPTIONS: Partial<Record<Exclude<Pool, 'outbox'>, PoolOptions>> = {
  email: { groupRetryMs: 100, groupRetryMaxMs: 1_000 },
  digest: { concurrency: DIGEST_CONCURRENCY },
};
