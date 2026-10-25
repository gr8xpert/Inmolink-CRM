import { isAppError } from '@inmolink/platform/errors';
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { forgetListingActivities, recordActivity } from './activities';
import { forgetListingEvents, sendEventReminder, sweepEventReminders } from './calendar';
import { eraseContactData } from './erasure';
import { runContactImport, sweepContactImports } from './import';
import { notifyLeadAssigned } from './lead-notices';
import { promoteInboundLead } from './leads';
import { forgetListingProspects, repointSellerListings } from './prospects';
import { refreshReportDay, refreshStageCounts, STAGE_COUNTS_LAG_MS, stageCountAgencies } from './report-rollups';
import { forgetListingTasks, sendTaskReminder, sweepTaskReminders } from './tasks';

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
 *   id): the purged listing leaves the agency's timelines, in batches of 1,000 (and its tasks, events and the seller
 *   prospect it was converted from, S10-07).
 * - `crm.repointSellerListings` (pool `maintenance`, one per `crm.contact.merged` event, job ID = the event's id,
 *   S10-07): the agency's listings whose seller was the closed contact name the survivor (`property_privates`, through
 *   properties' index). Idempotent: a redelivery finds nothing left to move.
 * - `crm.eraseContactData` (pool `maintenance`, one per `crm.contact.erased` event, job ID = the event's id,
 *   S11-F12): the erased contact's and its leads' activity bodies (batches of 1,000), the inbound website leads its leads
 *   came from (websites, 500 at a time), then the agency's listings whose seller it (or a contact merged into it) was
 *   name none (`property_privates`, through properties); audits `crm.contact.erasureCompleted` with the counts.
 *   Idempotent: a rerun finds nothing left.
 * - `crm.refreshStageCounts` (S12-F6): the agency's leads per stage by deltas — the stage moves since its last pass,
 *   up to `STAGE_COUNTS_LAG_MS` ago, one history row read per move, one rollup row written per stage touched; queues
 *   one more pass while newer moves wait. `crm.sweepStageCounts` (pool `maintenance`, daily) queues a full rebuild
 *   (`full`) of every agency with counts, 500 agencies per page, so any drift lasts a day at most.
 * - `crm.refreshStageCounts` / `crm.refreshReportDay` (pool `indexing` — projections; S11-F10): rebuild the agency's
 *   leads-per-stage rollup, and its per-day rollups of one UTC day (response KPI, moves), from `leads` and
 *   `lead_stage_history` (`report-rollups.ts`). Queued from
 *   `crm.lead.created`, `crm.lead.stageChanged` and `crm.lead.responded`, throttled per agency (and day): a burst
 *   becomes one rebuild per window. Idempotent (rebuilt from the source, never incremented); one per agency at a time.
 * - `crm.sweepTaskReminders` (pool `maintenance`, every minute, S10-05): claims the tasks that came due and writes one
 *   `crm.task.reminderDue` event each, in the claiming transaction (`FOR UPDATE SKIP LOCKED`: concurrent passes take
 *   different rows).
 * - `crm.sweepEventReminders` (pool `maintenance`, every minute, S10-06): claims the calendar events whose reminder
 *   came and writes one `crm.calendarEvent.reminderDue` event per member attendee, in the claiming transaction.
 * - `crm.sendEventReminder` (pool `email`, one per `crm.calendarEvent.reminderDue` event, job ID = event + remind time +
 *   member, S10-06): the member's reminder e-mail, once — the send is claimed in the database before it goes out.
 * - `crm.sendTaskReminder` (pool `email`, one per `crm.task.reminderDue` event, job ID = task + due time + claim time, S10-05): the
 *   reminder e-mail, once — the send is claimed in the database before it goes out (`tasks.ts`); S12-F2: the claim's
 *   transaction also raises the assignee's in-app `TASK_DUE` notification.
 * - `crm.notifyLeadAssigned` (pool `realtime` — a live in-app notice; one per `crm.lead.created` / `crm.lead.updated`
 *   event naming an assignee, job ID = the event's id, S12-F2): the assignee's `LEAD_ASSIGNED` notification
 *   (`lead-notices.ts`). Idempotent (`sourceKey` = the event's id).
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
      type: z.enum(['LEAD_CREATED', 'LEAD_UPDATED', 'STAGE_CHANGED', 'CONTACT_MERGED', 'LISTING_STATUS_CHANGED']),
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

  notifyLeadAssigned: defineJob({
    name: 'crm.notifyLeadAssigned',
    pool: 'realtime',
    payload: z.object({
      eventId: z.uuid(),
      agencyId: z.uuid(),
      leadId: z.uuid(),
      userId: z.uuid(),
      assignedBy: z.uuid().nullable(),
      inbound: z.boolean(),
      /** The lead's version the event left (S12-F2 review). */
      version: z.number().int(),
      occurredAt: z.iso.datetime(),
    }),
    jobId: (p) => `crm.notifyLeadAssigned:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 30_000,
    async run(p) {
      return notifyLeadAssigned(p);
    },
  }),

  sweepTaskReminders: defineJob({
    name: 'crm.sweepTaskReminders',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 60_000,
    attempts: 3,
    timeoutMs: 2 * 60_000,
    async run(_p, { log, signal }) {
      const { claimed } = await sweepTaskReminders({ signal });
      if (claimed.length > 0) log.info({ claimed: claimed.length }, 'task reminders claimed');
      return { claimed: claimed.length };
    },
  }),

  sendTaskReminder: defineJob({
    name: 'crm.sendTaskReminder',
    pool: 'email',
    payload: z.object({ agencyId: z.uuid(), taskId: z.uuid(), dueMs: z.number().int(), remindedMs: z.number().int() }),
    // the claim's time too: a re-armed task (reopened) is a new job, never one the queue still remembers
    jobId: (p) => `${p.taskId}:${p.dueMs}:${p.remindedMs}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 30_000,
    async run(p) {
      return sendTaskReminder(p);
    },
  }),

  sweepEventReminders: defineJob({
    name: 'crm.sweepEventReminders',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 60_000,
    attempts: 3,
    timeoutMs: 2 * 60_000,
    async run(_p, { log, signal }) {
      const { claimed } = await sweepEventReminders({ signal });
      if (claimed.length > 0) log.info({ claimed: claimed.length }, 'calendar reminders claimed');
      return { claimed: claimed.length };
    },
  }),

  sendEventReminder: defineJob({
    name: 'crm.sendEventReminder',
    pool: 'email',
    payload: z.object({ agencyId: z.uuid(), eventId: z.uuid(), userId: z.uuid(), remindMs: z.number().int() }),
    jobId: (p) => `${p.eventId}:${p.remindMs}:${p.userId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 30_000,
    async run(p) {
      return sendEventReminder(p);
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
      const activities = await forgetListingActivities(p);
      const tasks = await forgetListingTasks(p);
      const events = await forgetListingEvents(p);
      const prospects = await forgetListingProspects(p);
      return { ...activities, tasks: tasks.rows, events: events.rows, prospects: prospects.rows };
    },
  }),

  repointSellerListings: defineJob({
    name: 'crm.repointSellerListings',
    pool: 'maintenance',
    payload: z.object({ eventId: z.uuid(), agencyId: z.uuid(), survivorId: z.uuid(), mergedId: z.uuid() }),
    jobId: (p) => p.eventId,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 60_000,
    async run(p) {
      return repointSellerListings(p);
    },
  }),

  eraseContactData: defineJob({
    name: 'crm.eraseContactData',
    pool: 'maintenance',
    payload: z.object({ eventId: z.uuid(), agencyId: z.uuid(), contactId: z.uuid() }),
    jobId: (p) => p.eventId,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 5 * 60_000,
    async run(p) {
      return eraseContactData(p);
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

  refreshStageCounts: defineJob({
    name: 'crm.refreshStageCounts',
    pool: 'indexing',
    // S12-F6: `full` — the nightly rebuild from `leads`; otherwise the delta pass (the stage moves since the last one)
    payload: z.object({ agencyId: z.uuid(), full: z.boolean().optional() }),
    group: (p) => p.agencyId,
    // one pass over an agency's rollup at a time (the service also holds an advisory lock)
    concurrencyPerGroup: 1,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 60_000,
    async run(p) {
      const result = await refreshStageCounts(p);
      // moves newer than the cutoff (their own enqueues fell inside this run's throttle window): one more pass
      if (result.pending) await queueStageCounts(p.agencyId);
      return { agencyId: p.agencyId, ...result };
    },
  }),

  sweepStageCounts: defineJob({
    name: 'crm.sweepStageCounts',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 24 * 3_600_000,
    attempts: 3,
    timeoutMs: 10 * 60_000,
    async run(_p, { log, signal }) {
      let after: string | null = null;
      let queued = 0;
      while (!signal.aborted) {
        const agencies = await stageCountAgencies(after);
        if (agencies.length === 0) break;
        await crmJobs.refreshStageCounts.enqueueMany(
          agencies.map((agencyId) => ({ payload: { agencyId, full: true } })),
        );
        queued += agencies.length;
        after = agencies.at(-1) ?? null;
      }
      log.info({ queued }, 'nightly stage-count rebuilds queued');
      return { queued };
    },
  }),

  refreshReportDay: defineJob({
    name: 'crm.refreshReportDay',
    pool: 'indexing',
    payload: z.object({ agencyId: z.uuid(), day: z.iso.date() }),
    group: (p) => p.agencyId,
    concurrencyPerGroup: 1,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 60_000,
    async run(p) {
      await refreshReportDay(p);
      return p;
    },
  }),
};

/**
 * S11-F10: a burst of one agency's lead changes rebuilds its rollups once per window (`throttleMs`). S12-F6: the stage
 * counts' window outlasts the pass's lag, so the pass that a move queues reaches that move.
 */
export const STAGE_COUNTS_THROTTLE_MS = STAGE_COUNTS_LAG_MS + 5_000;
export const REPORT_DAY_THROTTLE_MS = 10_000;

/** Queues the agency's leads-per-stage rebuild (throttled: enqueues inside the window join the queued run). */
export async function queueStageCounts(agencyId: string): Promise<void> {
  await crmJobs.refreshStageCounts.enqueue(
    { agencyId },
    { throttleMs: STAGE_COUNTS_THROTTLE_MS, debounceKey: 'stage-counts' },
  );
}

/**
 * The UTC days whose per-day rollups an event at these instants (epoch ms) touches. Within a minute of a midnight
 * the neighbouring day too: the lead's receipt (`created_ms`, the database's clock) and its history row (the service's
 * clock) can fall on either side of it.
 */
export function reportDaysOf(...instants: readonly number[]): string[] {
  const days = new Set<string>();
  for (const ms of instants) {
    for (const t of [ms - 60_000, ms, ms + 60_000]) days.add(new Date(t).toISOString().slice(0, 10));
  }
  return [...days].sort();
}

/** Queues the rebuild of the agency's per-day rollups of the days of `instants` (throttled per agency and day). */
export async function queueReportDay(agencyId: string, ...instants: readonly number[]): Promise<void> {
  for (const day of reportDaysOf(...instants)) {
    await crmJobs.refreshReportDay.enqueue(
      { agencyId, day },
      { throttleMs: REPORT_DAY_THROTTLE_MS, debounceKey: `report-day.${day}` },
    );
  }
}
