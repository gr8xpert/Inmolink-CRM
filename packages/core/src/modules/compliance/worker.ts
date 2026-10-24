/**
 * compliance — worker-only entry (`@inmolink/core/modules/compliance/worker`, S10-08). The data export run reads
 * crm, properties, media and identity through their worker readers, and those modules import compliance (`audit`): so
 * the run, its jobs and its subscriptions live here, outside the public `index.ts` the dashboard API imports. Only
 * `apps/worker`, tests and scripts may import this file (`core-module-worker-entry-workers-only`).
 */
import { subscribe } from '@inmolink/platform/outbox';
import { dataExportJobs } from './data-export-jobs';
import { complianceEvents } from './events';

export { dataExportJobs } from './data-export-jobs';
export { configureDataExportNotice, dataExportNoticeRecipients, renderDataExportNotice } from './data-export-notice';
export {
  configureDataExport,
  DATA_EXPORT_STUCK_MS,
  EXPORT_PAGE_ROWS,
  runDataExport,
  sweepDataExports,
} from './data-export-run';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → worker: each `compliance.dataExport.requested` event queues one `compliance.runDataExport` job and one
 * `compliance.notifyDataExport` (the admins' alert). Job IDs make a redelivered event add nothing.
 */
export function registerComplianceWorkerSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      complianceEvents.dataExportRequested,
      (payload, meta) => dataExportJobs.runDataExport.enqueue({ agencyId: meta.agencyId, exportId: payload.exportId }),
      { name: 'compliance.dataExport.run' },
    ),
    subscribe(
      complianceEvents.dataExportRequested,
      (payload, meta) =>
        dataExportJobs.notifyDataExport.enqueue({ agencyId: meta.agencyId, exportId: payload.exportId }),
      { name: 'compliance.dataExport.notify' },
    ),
  ];
}

export function unregisterComplianceWorkerSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
