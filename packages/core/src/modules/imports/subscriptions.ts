import { subscribe } from '@inmolink/platform/outbox';
import { importsEvents } from './events';
import { importsJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → imports worker. Each `imports.run.requested` event (a member's "run now" or the scheduler) becomes one
 * `imports.runFeed` job, job ID = the run's id (a redelivered event adds nothing). The tenant is `meta.agencyId`
 * (RLS-checked when the event was written), the fair-share group. Called once by the worker.
 */
export function registerImportsSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      importsEvents.runRequested,
      (payload, meta) => importsJobs.runFeed.enqueue({ runId: payload.runId, agencyId: meta.agencyId }),
      { name: 'imports.run.start' },
    ),
  ];
}
