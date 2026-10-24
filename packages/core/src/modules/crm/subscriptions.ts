import { subscribe } from '@inmolink/platform/outbox';
import { crmEvents } from './events';
import { crmJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → crm worker. Each `crm.import.requested` event becomes one `crm.importContacts` job (job ID = the import's
 * id: a redelivered event adds nothing). The tenant is `meta.agencyId` (RLS-checked when the event was written), the
 * fair-share group. Called once by the worker.
 */
export function registerCrmSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      crmEvents.importRequested,
      (payload, meta) => crmJobs.importContacts.enqueue({ agencyId: meta.agencyId, importId: payload.importId }),
      { name: 'crm.import.start' },
    ),
  ];
}

export function unregisterCrmSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
