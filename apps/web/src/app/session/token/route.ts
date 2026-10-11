import { Audience } from '@inmolink/contracts';
import { authCtx } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { auth } from '@/auth';
import { checkLimits, LIMITS } from '@/server/limits';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * `GET /session/token?aud=api|realtime` → `{ token, expiresAt }`: a 15-minute access token for the
 * signed-in user. Same-origin only by construction: the session cookie is SameSite=Strict and the
 * JSON response is unreadable cross-origin (no CORS headers).
 */
export async function GET(request: Request): Promise<Response> {
  const audience = Audience.safeParse(new URL(request.url).searchParams.get('aud'));
  if (!audience.success) return error(400, 'BAD_REQUEST');
  const session = await auth();
  if (!session?.user?.id) return error(401, 'NOT_AUTHENTICATED');
  if ((await checkLimits([[LIMITS.tokenUser, session.user.id]])) > 0) return error(429, 'RATE_LIMITED');
  try {
    const dto = await identity.issueAccessToken(authCtx(newId()), {
      userId: session.user.id,
      sessionVersion: session.user.sessionVersion,
      mfaVerified: session.user.mfaVerified,
      audience: audience.data,
    });
    return Response.json(dto, { headers: NO_STORE });
  } catch (err) {
    if (isAppError(err) && err.code === 'SESSION_REVOKED') return error(401, 'SESSION_REVOKED');
    // The session still owes its second factor (S1-04): the client sends the user to /two-factor.
    if (isAppError(err) && err.code === 'MFA_REQUIRED') return error(403, 'MFA_REQUIRED');
    throw err;
  }
}

function error(status: number, code: string): Response {
  return Response.json({ error: { code, message: code } }, { status, headers: NO_STORE });
}
