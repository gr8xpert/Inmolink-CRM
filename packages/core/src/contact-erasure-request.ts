import type { EraseContactBody } from '@inmolink/contracts';
import type { Ctx } from './context';
import * as crm from './modules/crm';
import { stepUpCheck } from './step-up';

/**
 * The contact erasure request (S17-F2): crm's `eraseContact` with identity's step-up bound in. Erasing a person for good
 * needs a fresh second-factor code, checked in core (not in a route) and only after policy and the version check — see
 * `eraseContact`. This is what apps call.
 */
export function requestContactErasure(ctx: Ctx, contactId: string, input: EraseContactBody): Promise<void> {
  return crm.eraseContact(
    ctx,
    contactId,
    { version: input.version, confirm: input.confirm },
    { verifyStepUp: stepUpCheck(ctx, input.twoFactorCode, { action: 'crm.contacts.erase' }) },
  );
}
