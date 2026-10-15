import { subscribe } from '@inmolink/platform/outbox';
import { propertiesEvents } from './events';
import { propertiesJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → properties worker. Each `properties.bulkAction.requested` event becomes one
 * `properties.runBulkAction` job (stable job ID = the action's id). The tenant is `meta.agencyId` (RLS-checked
 * when the event was written), the fair-share group. Called once by the worker.
 */
export function registerPropertiesSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      propertiesEvents.bulkRequested,
      (payload, meta) =>
        propertiesJobs.runBulkAction.enqueue({
          bulkActionId: payload.bulkActionId,
          agencyId: meta.agencyId,
          userId: payload.userId,
        }),
      { name: 'properties.bulk.run' },
    ),
  ];
}

/** Tests: drop the subscriptions again. */
export function unregisterPropertiesSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
