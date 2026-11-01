import { TwoFactorCode } from '@inmolink/contracts';
import { authCtx } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import { createFounder } from '@inmolink/core/test';
import { adminQuery } from '@inmolink/db/testing';
import { totpCode, totpStep } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';

const PASSWORD = 'correct horse battery'; // createFounder's

/**
 * A founder with an authenticator app (S11-F14; shared by the step-up route tests since S17-F2). `code()` yields one
 * usable code per call: the next TOTP step first, then the recovery codes (a TOTP step is single-use, so several
 * requests in one second need distinct codes). Needs `identity.configureIdentity` with a keyring.
 */
export async function founderWithAuthenticator(role?: 'AGENT') {
  const f = await createFounder();
  if (role) {
    await adminQuery('update agency_members set role = $1 where user_id = $2', [role, f.userId]);
  }
  const { secret } = await identity.startEnrolment(authCtx(newId()), { userId: f.userId, password: PASSWORD });
  const done = await identity.confirmEnrolment(authCtx(newId()), {
    userId: f.userId,
    sessionVersion: 1,
    sessionId: `web-session-${newId()}`,
    code: totpCode(secret, totpStep(new Date())),
  });
  const recovery = [...done.recoveryCodes];
  // the enrolment consumed the current step: the next one is accepted within the drift window
  const totp = [totpCode(secret, totpStep(new Date()) + 1)];
  return { ...f, secret, code: () => TwoFactorCode.parse(totp.shift() ?? recovery.shift()) };
}
