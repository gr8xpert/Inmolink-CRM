import { subscribe } from '@inmolink/platform/outbox';
import * as websites from '../websites';
import { crmEvents } from './events';
import { crmJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → crm worker. Each `crm.import.requested` event becomes one `crm.importContacts` job (job ID = the import's
 * id: a redelivered event adds nothing). The tenant is `meta.agencyId` (RLS-checked when the event was written), the
 * fair-share group. Each `websites.lead.received` event (S10-02) becomes one `crm.promoteInboundLead` job (job ID = the
 * inbound lead's id). Called once by the worker.
 */
export function registerCrmSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      crmEvents.importRequested,
      (payload, meta) => crmJobs.importContacts.enqueue({ agencyId: meta.agencyId, importId: payload.importId }),
      { name: 'crm.import.start' },
    ),
    subscribe(
      websites.websitesEvents.leadReceived,
      (payload, meta) => crmJobs.promoteInboundLead.enqueue({ agencyId: meta.agencyId, inboundLeadId: payload.leadId }),
      { name: 'crm.lead.promote' },
    ),
  ];
}

export function unregisterCrmSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
