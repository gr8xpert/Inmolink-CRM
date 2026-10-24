import { isAppError } from '@inmolink/platform/errors';
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { forgetListingActivities, recordActivity } from './activities';
import { runContactImport, sweepContactImports } from './import';
import { promoteInboundLead } from './leads';

const IMPORT_ATTEMPTS = 3;

/**
 * crm worker jobs (PATTERNS §12). Idempotent, batched, per-tenant fair share.
 *
 * - `crm.importContacts` (pool `imports`, one per `crm.import.requested` event, job ID = the import's id): streams the
 *   uploaded file in batches of 500 rows, one transaction each, resuming after the import's checkpoint on a retry.
 *   One import per agency at a time.
 * - `crm.sweepContactImports` (pool `maintenance`, daily): expires uploads never started within 24 h and deletes the
 *   files still in storage (those uploads, and finished runs whose own delete failed).
 * - `crm.promoteInboundLead` (pool `email` — the speed-to-lead pool, with the acknowledgement and the agency
 *   notification; one per `websites.lead.received` event, job ID = the inbound lead's id): the website lead becomes a
 *   lead in the presenting agency's inbox, assigned by its rule (S10-02, < 10 s p95 from the event). Idempotent per
 *   inbound lead (advisory lock + `leads_inbound_uq`), one per agency at a time. A retry follows a lost race on a
 *   contact's e-mail or phone; a lead never promoted is still announced to the agency (website-api's fallback).
 * - `crm.recordActivity` (pool `indexing` — a projection like the read models; one per subscribed outbox event, job ID
 *   = the event's id, S10-04): the event's activity on the timeline. Idempotent: the row carries the event's id and time
 *   (`activities_event_uq`), so a redelivered event or a retried job writes nothing more. A row no month can hold (23514)
 *   fails at once, non-retryable, logged with the event's id.
 * - `crm.forgetListingActivities` (pool `maintenance`, one per `properties.listing.purged` event, job ID = the event's
 *   id): the purged listing leaves the agency's timelines, in batches of 1,000.
 */
export const crmJobs = {
  importContacts: defineJob({
    name: 'crm.importContacts',
    pool: 'imports',
    payload: z.object({ agencyId: z.uuid(), importId: z.uuid() }),
    jobId: (p) => p.importId,
    group: (p) => p.agencyId,
    concurrencyPerGroup: 1,
    attempts: IMPORT_ATTEMPTS,
    backoff: { type: 'exponential', delay: 30_000 },
    timeoutMs: 30 * 60_000,
    async run(p, job) {
      return runContactImport(p, { log: job.log, signal: job.signal, lastAttempt: job.attempt >= IMPORT_ATTEMPTS });
    },
  }),

  promoteInboundLead: defineJob({
    name: 'crm.promoteInboundLead',
    pool: 'email',
    payload: z.object({ agencyId: z.uuid(), inboundLeadId: z.uuid() }),
    jobId: (p) => p.inboundLeadId,
    group: (p) => p.agencyId,
    // one promotion per agency at a time: a burst of one agency's leads never holds the e-mail pool's slots
    concurrencyPerGroup: 1,
    attempts: 5,
    backoff: { type: 'exponential', delay: 1_000 },
    timeoutMs: 30_000,
    async run(p, { log }) {
      const result = await promoteInboundLead(p);
      if (result.created) log.info({ leadId: result.leadId, inboundLeadId: p.inboundLeadId }, 'website lead promoted');
      return result;
    },
  }),

  recordActivity: defineJob({
    name: 'crm.recordActivity',
    pool: 'indexing',
    payload: z.object({
      eventId: z.uuid(),
      agencyId: z.uuid(),
      occurredAt: z.iso.datetime(),
      type: z.enum(['LEAD_CREATED', 'LEAD_UPDATED', 'CONTACT_MERGED', 'LISTING_STATUS_CHANGED']),
      contactId: z.uuid().optional(),
      leadId: z.uuid().optional(),
      listingId: z.uuid().optional(),
      data: z.record(z.string(), z.union([z.string().max(64), z.number(), z.null()])),
    }),
    jobId: (p) => p.eventId,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 30_000,
    async run(p, { log }) {
      try {
        return await recordActivity(p);
      } catch (err) {
        if (isAppError(err) && !err.retryable) log.error({ eventId: p.eventId, type: p.type }, 'activity not recorded');
        throw err;
      }
    },
  }),

  forgetListingActivities: defineJob({
    name: 'crm.forgetListingActivities',
    pool: 'maintenance',
    payload: z.object({ eventId: z.uuid(), agencyId: z.uuid(), listingId: z.uuid() }),
    jobId: (p) => p.eventId,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 5 * 60_000,
    async run(p) {
      return forgetListingActivities(p);
    },
  }),

  sweepContactImports: defineJob({
    name: 'crm.sweepContactImports',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 24 * 3_600_000,
    attempts: 3,
    timeoutMs: 10 * 60_000,
    async run(_p, { log, signal }) {
      const result = await sweepContactImports({ signal });
      if (result.expired > 0 || result.filesDeleted > 0) log.info(result, 'contact import files swept');
      return result;
    },
  }),
};
