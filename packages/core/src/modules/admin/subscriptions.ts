import { subscribe } from '@inmolink/platform/outbox';
import { adminEvents } from './events';
import { adminJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → admin worker (S13-03, called once by the worker): a staff bulk operation, once the transaction that
 * started it committed, gets its job (job ID = the operation's id: a redelivered event queues nothing new).
 */
export function registerAdminSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      adminEvents.operationRequested,
      async (payload) => {
        await adminJobs.runStaffOperation.enqueue({ operationId: payload.operationId });
      },
      { name: 'admin.operation.run' },
    ),
  ];
}

export function unregisterAdminSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
