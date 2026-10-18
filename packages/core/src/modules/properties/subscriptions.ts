import { subscribe } from '@inmolink/platform/outbox';
import { developmentsEvents } from '../developments';
import { propertiesEvents } from './events';
import { propertiesJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → properties worker. Each `properties.bulkAction.requested` event becomes one
 * `properties.runBulkAction` job (stable job ID = the action's id). The tenant is `meta.agencyId` (RLS-checked
 * when the event was written), the fair-share group. A purged listing, a deleted unit or a deleted development
 * becomes one `properties.removeOverrides` job (S5-F2, job ID = event ID). Called once by the worker.
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
    subscribe(
      propertiesEvents.purged,
      (payload, meta) =>
        propertiesJobs.removeOverrides.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          targetKind: 'LISTING',
          targetId: payload.listingId,
        }),
      { name: 'properties.overrides.listingPurged' },
    ),
    subscribe(
      developmentsEvents.unitDeleted,
      (payload, meta) =>
        propertiesJobs.removeOverrides.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          targetKind: 'UNIT',
          targetId: payload.unitId,
        }),
      { name: 'properties.overrides.unitDeleted' },
    ),
    subscribe(
      developmentsEvents.deleted,
      (payload, meta) =>
        propertiesJobs.removeOverrides.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          targetKind: 'DEVELOPMENT',
          targetId: payload.developmentId,
        }),
      { name: 'properties.overrides.developmentDeleted' },
    ),
  ];
}

/** Tests: drop the subscriptions again. */
export function unregisterPropertiesSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
