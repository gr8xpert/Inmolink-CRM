import type { CreateDataExportBody, DataExportDto } from '@inmolink/contracts';
import { AppError } from '@inmolink/platform/errors';
import { authCtx, type Ctx } from './context';
import * as compliance from './modules/compliance';
import * as identity from './modules/identity';

/**
 * The data export request (S11-F14): compliance's create with identity's step-up bound in. Copying the agency's data out
 * needs a fresh second-factor code, checked here in core (not in a route) and only after policy, the idempotent replay
 * and the one-export-at-a-time rule — see `createDataExport`. Lives at the core root because compliance cannot import
 * identity (identity imports compliance). This is what apps call.
 */
export function requestDataExport(
  ctx: Ctx,
  input: CreateDataExportBody,
  opts: { idempotencyKey?: string } = {},
): Promise<{ export: DataExportDto; replayed: boolean }> {
  return compliance.createDataExport(
    ctx,
    { kind: input.kind, format: input.format },
    {
      ...opts,
      verifyStepUp: async () => {
        if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
        await identity.verifyStepUp(authCtx(ctx.requestId), {
          userId: ctx.actor.userId,
          code: input.twoFactorCode,
          unlocks: { action: 'compliance.dataExport.create', kind: input.kind },
        });
      },
    },
  );
}
