import { AppError } from '@inmolink/platform/errors';
import { authCtx, type Ctx, type StaffCtx } from './context';
import * as identity from './modules/identity';

type StepUpCode = Parameters<typeof identity.verifyStepUp>[1]['code'];

/**
 * S17-F1: the one step-up check the core-root use cases bind into a module that cannot import identity (compliance,
 * admin) — `requestDataExport`, `updateRetentionSettings`, `startStaffOperation`. The returned check, when the module
 * runs it: a member (or staff) only — an API key or system work is `FORBIDDEN`; no code is `MFA_CODE_INVALID`; then
 * identity's fresh second factor, audited with what it unlocks.
 */
export function stepUpCheck(
  ctx: Ctx | StaffCtx,
  code: StepUpCode | undefined,
  unlocks: { action: string; kind?: string },
): () => Promise<void> {
  return async () => {
    if (ctx.actor.kind !== 'user' && ctx.actor.kind !== 'staff') throw new AppError('FORBIDDEN');
    if (!code) throw new AppError('MFA_CODE_INVALID');
    await identity.verifyStepUp(authCtx(ctx.requestId), { userId: ctx.actor.userId, code, unlocks });
  };
}
