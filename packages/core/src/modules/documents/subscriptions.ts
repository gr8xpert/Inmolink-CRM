import { subscribe } from '@inmolink/platform/outbox';
import * as crm from '../crm';
import { documentsEvents } from './events';
import { documentsJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → documents (R2-05a): a made form is rendered (job id = the form id: a redelivered event queues nothing new);
 * a merged contact's forms follow the survivor; an erased contact's forms are deleted. The tenant is `meta.agencyId` (RLS-checked), never the payload's. Called once
 * by the worker.
 */
export function registerDocumentsSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      documentsEvents.formCreated,
      (payload, meta) => documentsJobs.renderForm.enqueue({ formId: payload.formId, agencyId: meta.agencyId }),
      { name: 'documents.form.render' },
    ),
    subscribe(
      crm.crmEvents.contactMerged,
      (payload, meta) =>
        documentsJobs.repointContactForms.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          survivorId: payload.survivorId,
          mergedId: payload.mergedId,
        }),
      { name: 'documents.contact.merged' },
    ),
    subscribe(
      crm.crmEvents.contactErased,
      (payload, meta) =>
        documentsJobs.eraseContactForms.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          contactId: payload.contactId,
        }),
      { name: 'documents.contact.erased' },
    ),
    // R2-05b, e-signature: the tenant is the event's (RLS-checked); each job checks the row is that agency's.
    subscribe(
      documentsEvents.signatureRequested,
      (payload, meta) =>
        documentsJobs.inviteSigners.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          requestId: payload.requestId,
        }),
      { name: 'documents.signature.invite' },
    ),
    subscribe(
      documentsEvents.signatureCodeRequested,
      (payload, meta) =>
        documentsJobs.sendSigningCode.enqueue({
          agencyId: meta.agencyId,
          signerId: payload.signerId,
          otpId: payload.otpId,
        }),
      { name: 'documents.signature.code' },
    ),
    subscribe(
      documentsEvents.signatureSigned,
      (payload, meta) =>
        documentsJobs.applySignature.enqueue({
          agencyId: meta.agencyId,
          signerId: payload.signerId,
          eventId: payload.eventId,
        }),
      { name: 'documents.signature.apply' },
    ),
    subscribe(
      documentsEvents.signatureAllSigned,
      (payload, meta) => documentsJobs.sealSignature.enqueue({ agencyId: meta.agencyId, requestId: payload.requestId }),
      { name: 'documents.signature.seal' },
    ),
    subscribe(
      documentsEvents.signatureCompleted,
      (payload, meta) =>
        documentsJobs.notifySignatureCompleted.enqueue({ agencyId: meta.agencyId, requestId: payload.requestId }),
      { name: 'documents.signature.notify' },
    ),
  ];
}

/** Tests. */
export function unregisterDocumentsSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
