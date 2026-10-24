import { clock } from '@inmolink/platform/clock';
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { mlsEvents } from './events';
import { agenciesToRehash, pruneExpiredFingerprints, rehashAgencyFingerprints } from './maintenance';
import { repointRegistrations } from './service';
import { expireViewingRequests, notifyViewingChange } from './viewings';

const HOUR_MS = 3_600_000;

/**
 * mls worker jobs (PATTERNS §12). Idempotent, batched, per-tenant fair share.
 *
 * - `mls.repointRegistrations` (pool `maintenance`, one per `crm.contact.merged` event, job ID = the event's id,
 *   S11-01): the agency's client registrations of the closed contact name the survivor. Idempotent: a redelivery finds
 *   nothing left to move.
 * - `mls.scheduleFingerprintRehash` (pool `maintenance`, hourly): during an HMAC rotation window (S11-F13), one
 *   `mls.rehashFingerprints` per agency with valid registrations (job ID = agency + hour); nothing otherwise.
 * - `mls.rehashFingerprints` (pool `maintenance`, group = the agency, one at a time per agency): adds the current key's
 *   fingerprints to the agency's valid registrations from their encrypted snapshot, batches of 500. Idempotent.
 * - `mls.pruneFingerprints` (pool `maintenance`, daily): deletes fingerprints expired more than 30 days ago, batches of
 *   1,000 (registrations and receipts are kept as evidence).
 * - `mls.expireViewingRequests` (pool `maintenance`, every 15 minutes, S11-02): unanswered viewing proposals past their
 *   expiry become `EXPIRED`, batches of 500, one `mls.viewing.changed` each. Idempotent.
 * - `mls.notifyViewing` (pool `maintenance`, one per `mls.viewing.changed`, job ID = the event's id, group = the event's
 *   agency): the other side's members are notified (both sides on expiry). Idempotent (`sourceKey`).
 */
export const mlsJobs = {
  repointRegistrations: defineJob({
    name: 'mls.repointRegistrations',
    pool: 'maintenance',
    payload: z.object({ eventId: z.uuid(), agencyId: z.uuid(), survivorId: z.uuid(), mergedId: z.uuid() }),
    jobId: (p) => p.eventId,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 60_000,
    async run(p) {
      return repointRegistrations(p);
    },
  }),

  rehashFingerprints: defineJob({
    name: 'mls.rehashFingerprints',
    pool: 'maintenance',
    payload: z.object({ agencyId: z.uuid(), hour: z.number().int() }),
    jobId: (p) => `${p.agencyId}:${p.hour}`,
    group: (p) => p.agencyId,
    concurrencyPerGroup: 1,
    attempts: 5,
    backoff: { type: 'exponential', delay: 30_000 },
    timeoutMs: 10 * 60_000,
    async run(p) {
      return rehashAgencyFingerprints(p.agencyId);
    },
  }),

  scheduleFingerprintRehash: defineJob({
    name: 'mls.scheduleFingerprintRehash',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: HOUR_MS,
    attempts: 3,
    timeoutMs: 5 * 60_000,
    async run(_p, { log }) {
      const agencyIds = await agenciesToRehash();
      const hour = Math.floor(clock.nowMs() / HOUR_MS);
      await mlsJobs.rehashFingerprints.enqueueMany(agencyIds.map((agencyId) => ({ payload: { agencyId, hour } })));
      if (agencyIds.length > 0) log.info({ agencies: agencyIds.length }, 'client fingerprint rehash queued');
      return { agencies: agencyIds.length };
    },
  }),

  expireViewingRequests: defineJob({
    name: 'mls.expireViewingRequests',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 15 * 60_000,
    attempts: 3,
    timeoutMs: 5 * 60_000,
    async run() {
      return expireViewingRequests();
    },
  }),

  notifyViewing: defineJob({
    name: 'mls.notifyViewing',
    pool: 'maintenance',
    payload: z.object({
      eventId: z.uuid(),
      agencyId: z.uuid(),
      createdMs: z.number().int(),
      change: mlsEvents.viewingChanged.schema,
    }),
    jobId: (p) => p.eventId,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 60_000,
    async run(p) {
      return notifyViewingChange(p.change, {
        eventId: p.eventId,
        agencyId: p.agencyId,
        createdAt: new Date(p.createdMs),
      });
    },
  }),

  pruneFingerprints: defineJob({
    name: 'mls.pruneFingerprints',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 24 * HOUR_MS,
    attempts: 3,
    timeoutMs: 10 * 60_000,
    async run() {
      return pruneExpiredFingerprints();
    },
  }),
};
