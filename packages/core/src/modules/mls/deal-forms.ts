import type { CreateCollaborationAgreementBody, FormDocumentDto } from '@inmolink/contracts';
import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import * as documents from '../documents';
import { getDeal } from './deals';
import { assertCan } from './policy';

/**
 * R2-05a, the deal room's collaboration agreement: `POST /v1/mls/deals/:id/collaboration-agreement`. A party's member
 * makes the agreement of a deal its agency is party to (its own copy, RLS) from the deal as the database keeps it —
 * both agencies, the property, the price, the terms snapshot and the commission the generated columns computed — never
 * from what the request says. Any stage but `FELL_THROUGH`; `mls.deals.write` (a verified agency's member). The forms library's rules apply (documents policy: no
 * Client Mode, never impersonated; the `documents.forms` flag). `Idempotency-Key` as `POST /v1/documents/forms`.
 */
export async function createDealCollaborationAgreement(
  ctx: Ctx,
  dealId: string,
  body: CreateCollaborationAgreementBody,
  opts: { idempotencyKey?: string } = {},
): Promise<{ form: FormDocumentDto; replayed: boolean }> {
  // the agreement binds the agency to a commission split: who binds on the network (a member of a verified agency)
  assertCan(ctx, 'mls.deals.write');
  const deal = await getDeal(ctx, dealId);
  if (deal.stage === 'FELL_THROUGH') throw new AppError('DEAL_STATE', { stage: deal.stage });
  return documents.createCollaborationAgreement(
    ctx,
    {
      id: deal.id,
      party: deal.party,
      counterpartName: deal.counterpartName,
      property: deal.targetLabel,
      price: deal.price,
      terms: {
        commissionBp: deal.terms.commissionBp,
        commissionFixed: deal.terms.commissionFixed,
        splitBp: deal.terms.splitBp,
        includesVat: deal.terms.includesVat,
      },
      commission: {
        totalCents: deal.commission.totalCents,
        introducerShareCents: deal.commission.introducerShareCents,
        ownerShareCents: deal.commission.ownerShareCents,
        currency: deal.commission.currency,
      },
    },
    body,
    opts,
  );
}
