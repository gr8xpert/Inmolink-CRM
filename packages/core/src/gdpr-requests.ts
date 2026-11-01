import type {
  RetentionSettingsDto,
  StaffOperationDto,
  StartStaffOperationBody,
  UpdateRetentionSettingsBody,
} from '@inmolink/contracts';
import { AppError } from '@inmolink/platform/errors';
import { authCtx, type Ctx, type StaffCtx } from './context';
import * as admin from './modules/admin';
import * as compliance from './modules/compliance';
import * as identity from './modules/identity';

/**
 * S16-04 review: the GDPR actions that cannot be undone need a fresh second factor, checked here in core (not in a
 * route) with identity's step-up — compliance and admin cannot import identity (identity imports compliance for its
 * audit trail), like `requestDataExport`. These are what apps call.
 *
 * - `updateRetentionSettings`: the agency's retention period (which clients the daily job erases for good).
 * - `startStaffOperation`: every staff bulk operation; `ERASE_AGENCY` carries the super admin's code (the others
 *   none — the contract refuses a code elsewhere).
 */

export function updateRetentionSettings(ctx: Ctx, input: UpdateRetentionSettingsBody): Promise<RetentionSettingsDto> {
  return compliance.setRetentionSettings(
    ctx,
    { inactiveContactMonths: input.inactiveContactMonths },
    {
      verifyStepUp: async () => {
        if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
        await identity.verifyStepUp(authCtx(ctx.requestId), {
          userId: ctx.actor.userId,
          code: input.twoFactorCode,
          unlocks: { action: 'compliance.retention.manage' },
        });
      },
    },
  );
}

export function startStaffOperation(ctx: StaffCtx, input: StartStaffOperationBody): Promise<StaffOperationDto> {
  if (input.kind !== 'ERASE_AGENCY') return admin.startOperation(ctx, input);
  // fail closed, decided on the kind: an agency erasure always goes through the step-up, and without a code it is
  // refused and no operation is created (admin.startOperation also refuses one without a step-up)
  const code = input.twoFactorCode;
  return admin.startOperation(ctx, input, {
    verifyStepUp: async () => {
      if (!code) throw new AppError('MFA_CODE_INVALID');
      await identity.verifyStepUp(authCtx(ctx.requestId), {
        userId: ctx.actor.userId,
        code,
        unlocks: { action: 'staff.admin.eraseAgency', kind: input.kind },
      });
    },
  });
}
