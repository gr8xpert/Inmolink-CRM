import { MeDto } from '@inmolink/contracts';
import { authCtx } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { webConfig } from './env';

const logger = createLogger({ service: 'web' });

/**
 * Server-side call to the dashboard API as the signed-in user: mints a 15-minute api token from the
 * session and calls `GET /v1/me`. `revoked` when the session can no longer mint (password reset).
 * The typed SDK client replaces the raw fetch once `pnpm sdk:generate` exists.
 */
export async function fetchMe(userId: string, sessionVersion: number): Promise<MeDto | 'revoked' | null> {
  const config = await webConfig();
  try {
    const { token } = await identity.issueAccessToken(authCtx(newId()), { userId, sessionVersion, audience: 'api' });
    const res = await fetch(`${config.API_URL}/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'api /v1/me refused the access token');
      return null;
    }
    return MeDto.parse(await res.json());
  } catch (err) {
    if (isAppError(err) && err.code === 'SESSION_REVOKED') return 'revoked';
    logger.error({ err }, 'api /v1/me call failed');
    return null;
  }
}
