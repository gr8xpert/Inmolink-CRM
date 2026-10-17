import { subscribe } from '@inmolink/platform/outbox';
import { developmentsEvents } from './events';
import { enqueueDocumentDelete } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → developments worker (S4-F4). A `developments.document.deleted` event becomes one
 * `developments.deleteDocumentObject` job (stable job ID = event ID); the tenant is `meta.agencyId` (RLS-checked
 * when the event was written), the fair-share group. Called once by the worker.
 */
export function registerDevelopmentsSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(developmentsEvents.documentDeleted, (payload, meta) => enqueueDocumentDelete(payload, meta), {
      name: 'developments.documents.delete',
    }),
  ];
}

/** Tests: drop the subscriptions again. */
export function unregisterDevelopmentsSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
