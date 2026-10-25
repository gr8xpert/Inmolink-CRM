import { subscribe } from '@inmolink/platform/outbox';
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import * as search from '../search';
import { sanitizeTargetTexts } from './white-label';

/**
 * The white-label sanitizer's model pass as a job (S12-03, PATTERNS §12, pool `ai`): one owner agency's changed
 * documents (≤ `search.PUBLIC_DOCS_EVENT_TARGETS` targets, every locale), queued by `search.publicDocs.changed`.
 * Idempotent (job ID = the event's id, so a redelivered event is one job; answered texts are skipped; the gateway
 * caches by input hash), per-tenant fair share, one at a time per agency so a bulk import cannot take the pool.
 */
export const whiteLabelJobs = {
  sanitizeTexts: defineJob({
    name: 'aiFeatures.sanitizeTexts',
    pool: 'ai',
    payload: z.object({
      /** The `search.publicDocs.changed` event: one job per event, a redelivered event collapses into it. */
      eventId: z.uuid(),
      agencyId: z.uuid(),
      targetIds: z.array(z.uuid()).min(1).max(100),
    }),
    jobId: (p) => p.eventId,
    group: (p) => p.agencyId,
    concurrencyPerGroup: 1,
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    timeoutMs: 5 * 60_000,
    async run(p, { log, jobId }) {
      const degradedCodes = new Set<string>();
      const result = await sanitizeTargetTexts(
        { agencyId: p.agencyId, targetIds: p.targetIds },
        { requestId: jobId, onDegrade: (code) => degradedCodes.add(code) },
      );
      if (result.degraded > 0) {
        log.warn({ ...result, codes: [...degradedCodes] }, 'white-label model pass degraded: deterministic only');
      }
      return result;
    },
  }),
};

let unsubscribe: (() => void)[] | undefined;

/** Outbox → the model pass: what websites show of these targets changed (S7-06's event). Called once by the worker. */
export function registerWhiteLabelSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      search.searchEvents.publicDocsChanged,
      async (payload, meta) => {
        await whiteLabelJobs.sanitizeTexts.enqueue({
          eventId: meta.eventId,
          agencyId: payload.agencyId,
          targetIds: payload.targetIds,
        });
      },
      { name: 'aiFeatures.whiteLabel.publicDocsChanged' },
    ),
  ];
}

/** Tests. */
export function unregisterWhiteLabelSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
