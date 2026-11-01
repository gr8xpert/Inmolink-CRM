import type { CreateDataExportBody, DataExportDto } from '@inmolink/contracts';
import type { Ctx } from './context';
import * as compliance from './modules/compliance';
import * as crm from './modules/crm';
import { stepUpCheck } from './step-up';

/**
 * The data export request (S11-F14): compliance's create with identity's step-up bound in. Copying the agency's data out
 * needs a fresh second-factor code, checked here in core (not in a route) and only after policy, the idempotent replay
 * and the one-export-at-a-time rule — see `createDataExport`. Lives at the core root because compliance cannot import
 * identity (identity imports compliance). This is what apps call. S16-04: `SUBJECT` exports check the contact through crm;
 * S17-F2: and need the confirmation step (`confirmContactId`).
 */
export function requestDataExport(
  ctx: Ctx,
  input: CreateDataExportBody,
  opts: { idempotencyKey?: string } = {},
): Promise<{ export: DataExportDto; replayed: boolean }> {
  return compliance.createDataExport(
    ctx,
    {
      kind: input.kind,
      format: input.format,
      ...(input.contactId ? { contactId: input.contactId } : {}),
      ...(input.confirmContactId ? { confirmContactId: input.confirmContactId } : {}),
    },
    {
      ...opts,
      // S16-04: a data subject export names an open contact of the agency (crm, under the request's RLS)
      subjectExists: (contactId) => crm.openContactExists(ctx.tx, ctx.tenant.agencyId, contactId),
      verifyStepUp: stepUpCheck(ctx, input.twoFactorCode, { action: 'compliance.dataExport.create', kind: input.kind }),
    },
  );
}
