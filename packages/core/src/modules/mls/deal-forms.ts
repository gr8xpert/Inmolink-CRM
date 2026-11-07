import {
  type CreateCollaborationAgreementBody,
  CreateDealSignatureRequestBody,
  type DealSignerRole,
  type DealSignersDto,
  type FormDocumentDto,
  type SignatureRequestDto,
} from '@inmolink/contracts';
import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import * as documents from '../documents';
import { getDeal } from './deals';
import * as repo from './deals-repo';
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

const ROLE_OF: Record<'OWNER' | 'INTRODUCER', DealSignerRole> = {
  OWNER: 'ownerAgency',
  INTRODUCER: 'introducerAgency',
};

/** The other agency's addresses, masked (one rule with the signing requests' DTOs). */
export const maskEmail = documents.maskEmail;

const otherParty = (p: 'OWNER' | 'INTRODUCER') => (p === 'OWNER' ? 'INTRODUCER' : 'OWNER');

/** The deal (the caller's party to it, not fallen through) and its signers, once the caller may ask for signatures. */
async function signersOfDeal(ctx: Ctx, dealId: string) {
  assertCan(ctx, 'mls.deals.write');
  await documents.assertCanRequestSignatures(ctx);
  const deal = await getDeal(ctx, dealId);
  if (deal.stage === 'FELL_THROUGH') throw new AppError('DEAL_STATE', { stage: deal.stage });
  return { deal, rows: await repo.dealSigners(ctx.tx, deal.id) };
}

/**
 * R2-05c `GET /v1/mls/deals/:id/signers`: who may sign the deal's collaboration agreement for each party — the deal's
 * member on that side (who asked for the viewing; the listing's agent) and the agency's admins, through the
 * `deal_signers()` definer; the other agency's addresses masked. Who may ask for the signatures only
 * (`mls.deals.write`, `documents.forms.sign`, both flags); a party only (`DEAL_NOT_FOUND`); not once fallen through.
 */
export async function dealSigners(ctx: Ctx, dealId: string): Promise<DealSignersDto> {
  const { deal, rows } = await signersOfDeal(ctx, dealId);
  const pick = (p: string, mask: boolean) =>
    rows
      .filter((r) => r.party === p)
      .map((r) => ({
        userId: r.user_id,
        name: r.name,
        email: mask ? maskEmail(r.email) : r.email,
        dealMember: r.deal_member,
      }));
  return {
    ownRole: ROLE_OF[deal.party],
    own: pick(deal.party, false),
    counterpart: pick(otherParty(deal.party), true),
  };
}

/**
 * R2-05c `POST /v1/mls/deals/:id/signature-requests`: both parties sign the deal's collaboration agreement. The form is
 * the caller's agency's agreement of this deal; each agency's signer is one of the party's deal members or admins,
 * named by user id — their name and address are the database's (`deal_signers()`), never the request's, so the
 * requester can neither name a stranger for the other agency nor relabel its signatory. `mls.deals.write`; any stage
 * but `FELL_THROUGH`; the documents rules apply (`documents.forms.sign`, both flags, one agreement in signature).
 */
export async function createDealSignatureRequest(
  ctx: Ctx,
  dealId: string,
  body: CreateDealSignatureRequestBody,
  opts: { idempotencyKey?: string } = {},
): Promise<{ request: SignatureRequestDto; replayed: boolean }> {
  const input = CreateDealSignatureRequestBody.parse(body);
  const { deal, rows } = await signersOfDeal(ctx, dealId);
  const own = rows.find((r) => r.party === deal.party && r.user_id === input.ownUserId);
  const other = rows.find((r) => r.party === otherParty(deal.party) && r.user_id === input.counterpartUserId);
  if (!own || !other) throw new AppError('SIGNERS_INVALID', { reason: 'party_member' });
  const allowed: Record<string, string[]> = {
    ownerAgency: rows.filter((r) => r.party === 'OWNER').map((r) => r.email),
    introducerAgency: rows.filter((r) => r.party === 'INTRODUCER').map((r) => r.email),
  };
  const signer = (r: repo.DealSignerRow) => ({ name: r.name, email: r.email, role: ROLE_OF[r.party] });
  return documents.createSignatureRequest(
    ctx,
    input.formId,
    {
      signers: [signer(own), signer(other)],
      ordered: input.ordered,
      expiresInDays: input.expiresInDays,
      ...(input.message ? { message: input.message } : {}),
    },
    { ...opts, deal: { dealId: deal.id, allowed } },
  );
}
