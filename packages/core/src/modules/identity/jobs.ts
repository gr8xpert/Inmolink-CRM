import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { newToken } from '@inmolink/platform/crypto';
import { mailer } from '@inmolink/platform/email';
import { newId } from '@inmolink/platform/ids';
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { identityConfig, TOKEN_TTL_MS } from './config';
import { type AuthEmailKind, renderAuthEmail } from './emails';
import * as repo from './repo';
import { hashLinkToken } from './service';

const LINK_PATH: Record<AuthEmailKind, string> = {
  VERIFY_EMAIL: '/verify-email',
  PASSWORD_RESET: '/reset-password',
  ACCOUNT_EXISTS: '/login',
};
const TOKEN_KIND: Partial<Record<AuthEmailKind, repo.TokenKind>> = {
  VERIFY_EMAIL: 'EMAIL_VERIFY',
  PASSWORD_RESET: 'PASSWORD_RESET',
};

/**
 * Sends one auth email (PATTERNS §12). The link token is created here, not in the request: it never
 * passes through the outbox or Redis, and only its HMAC is stored. A new link retires older unused
 * links of the same kind. Idempotent per outbox event (`jobId`); a retry after a failed send issues a
 * fresh link, so at most the latest emailed link works.
 */
export const identityJobs = {
  sendAuthEmail: defineJob({
    name: 'identity.sendAuthEmail',
    pool: 'email',
    payload: z.object({
      eventId: z.uuid(),
      userId: z.uuid(),
      kind: z.enum(['VERIFY_EMAIL', 'PASSWORD_RESET', 'ACCOUNT_EXISTS']),
    }),
    jobId: (p) => p.eventId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 30_000,
    async run(p, { log }) {
      const { webUrl } = identityConfig();
      if (!webUrl) throw new Error('identity: webUrl is not configured');
      const message = await withSystem(`identity.sendAuthEmail ${p.kind}`, async (tx) => {
        const user = await repo.findUserForEmail(tx, p.userId);
        if (user?.status !== 'ACTIVE') return null;
        if (p.kind === 'VERIFY_EMAIL' && user.emailVerifiedAt) return null;
        const url = new URL(LINK_PATH[p.kind], webUrl);
        const tokenKind = TOKEN_KIND[p.kind];
        if (tokenKind) {
          const token = newToken();
          const now = clock.now();
          await repo.replaceToken(
            tx,
            {
              id: newId(),
              userId: p.userId,
              kind: tokenKind,
              tokenHash: hashLinkToken(token),
              expiresAt: new Date(now.getTime() + TOKEN_TTL_MS[tokenKind]),
            },
            now,
          );
          url.searchParams.set('token', token);
        }
        return renderAuthEmail(p.kind, user, url.href);
      });
      if (!message) {
        log.info({ kind: p.kind }, 'auth email skipped (user inactive or already verified)');
        return;
      }
      // Outside the transaction (CLAUDE.md rule 6). Never log the message: it holds a one-time link.
      await mailer().send(message);
      log.info({ kind: p.kind }, 'auth email sent');
    },
  }),
};
