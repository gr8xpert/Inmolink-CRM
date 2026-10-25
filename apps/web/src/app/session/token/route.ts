import { Audience } from '@inmolink/contracts';
import * as identity from '@inmolink/core/modules/identity';
import { isAppError } from '@inmolink/platform/errors';
import { auth } from '@/auth';
import { checkLimits, LIMITS } from '@/server/limits';
import { requestAuthCtx } from '@/server/request-id';

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
    const dto = await identity.issueAccessToken(await requestAuthCtx(), {
      userId: session.user.id,
      sessionVersion: session.user.sessionVersion,
      mfaVerified: session.user.mfaVerified,
      audience: audience.data,
      // S12-06: a Client Mode session's tokens carry `cm` (and it gets no realtime token).
      ...(session.user.clientMode ? { clientMode: true } : {}),
      ...(session.user.sessionId ? { sessionId: session.user.sessionId } : {}),
    });
    return Response.json(dto, { headers: NO_STORE });
  } catch (err) {
    if (isAppError(err) && err.code === 'SESSION_REVOKED') return error(401, 'SESSION_REVOKED');
    // The session still owes its second factor (S1-04): the client sends the user to /two-factor.
    if (isAppError(err) && err.code === 'MFA_REQUIRED') return error(403, 'MFA_REQUIRED');
    if (isAppError(err) && err.code === 'FORBIDDEN') return error(403, 'FORBIDDEN');
    throw err;
  }
}

function error(status: number, code: string): Response {
  return Response.json({ error: { code, message: code } }, { status, headers: NO_STORE });
}
