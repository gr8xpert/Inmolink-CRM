import { withSystem } from '@inmolink/db';
import { cache, seen } from '@inmolink/platform/cache';
import { clock } from '@inmolink/platform/clock';
import { newToken } from '@inmolink/platform/crypto';
import { mailer } from '@inmolink/platform/email';
import { newId } from '@inmolink/platform/ids';
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import * as agencies from '../agencies';
import { API_KEY_USAGE_SET, apiKeyCacheKey } from './api-keys';
import * as keysRepo from './api-keys-repo';
import { API_KEYS, identityConfig, TOKEN_RETENTION_MS, TOKEN_TTL_MS } from './config';
import {
  type AuthEmailKind,
  emailLocale,
  renderAuthEmail,
  renderInviteEmail,
  renderTwoFactorNoticeEmail,
  renderVerificationDecisionEmail,
} from './emails';
import * as repo from './repo';
import { hashInviteToken, hashLinkToken, inviteTokenPrefix } from './service';

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
        // Locale-prefixed web route (S0-11): the page opens in the language of the email.
        const url = new URL(`/${emailLocale(user.locale)}${LINK_PATH[p.kind]}`, webUrl);
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

  /**
   * Notice to the owner that their second factor changed (S1-F8): turned on or off, a recovery code
   * used, a browser remembered. One job per event; skipped for an inactive user. No secret in the mail.
   */
  sendTwoFactorNotice: defineJob({
    name: 'identity.sendTwoFactorNotice',
    pool: 'email',
    payload: z.object({
      eventId: z.uuid(),
      userId: z.uuid(),
      kind: z.enum(['enabled', 'disabled', 'recoveryUsed', 'deviceRemembered']),
    }),
    jobId: (p) => p.eventId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 30_000,
    async run(p, { log }) {
      const { webUrl } = identityConfig();
      if (!webUrl) throw new Error('identity: webUrl is not configured');
      const message = await withSystem(`identity.sendTwoFactorNotice ${p.kind}`, async (tx) => {
        const user = await repo.findUserForEmail(tx, p.userId);
        if (user?.status !== 'ACTIVE') return null;
        const link = new URL(`/${emailLocale(user.locale)}/account/security`, webUrl).href;
        return renderTwoFactorNoticeEmail(p.kind, user, link);
      });
      if (!message) {
        log.info({ kind: p.kind }, 'two-factor notice skipped (user inactive)');
        return;
      }
      // Outside the transaction (CLAUDE.md rule 6).
      await mailer().send(message);
      log.info({ kind: p.kind }, 'two-factor notice sent');
    },
  }),

  /**
   * Sends the invite link (S1-02). Same rules as `sendAuthEmail`: the token is created here and only
   * its HMAC stored; a retry issues a fresh link and retires the previous one. Skipped once the invite
   * was accepted, revoked or expired, or its inviter is no longer an active admin.
   */
  sendInviteEmail: defineJob({
    name: 'identity.sendInviteEmail',
    pool: 'email',
    payload: z.object({ eventId: z.uuid(), agencyId: z.uuid(), inviteId: z.uuid() }),
    jobId: (p) => p.eventId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 30_000,
    async run(p, { log }) {
      const { webUrl } = identityConfig();
      if (!webUrl) throw new Error('identity: webUrl is not configured');
      const message = await withSystem('identity.sendInviteEmail', async (tx) => {
        const now = clock.now();
        const invite = await repo.findInviteForEmail(tx, p.inviteId, now);
        if (!invite || invite.agencyId !== p.agencyId) return null;
        // The inviter must still be an active admin there (S1-02 security review M1).
        const inviterRole = await repo.findMemberRole(tx, invite.agencyId, invite.invitedBy);
        if (inviterRole !== 'AGENCY_ADMIN' && inviterRole !== 'DEVELOPER_ADMIN') return null;
        const inviter = await repo.findUserForEmail(tx, invite.invitedBy);
        const agency = await agencies.getAgencyName(tx, invite.agencyId);
        if (!inviter || !agency) return null;
        const token = `${inviteTokenPrefix(invite.agencyId)}${newToken()}`;
        await repo.setInviteToken(tx, p.inviteId, hashInviteToken(token), now);
        const url = new URL(`/${emailLocale(invite.locale)}/accept-invite`, webUrl);
        url.searchParams.set('token', token);
        return renderInviteEmail(invite, { agency, inviter: inviter.name }, url.href);
      });
      if (!message) {
        log.info('invite email skipped (invite no longer open)');
        return;
      }
      // Outside the transaction (CLAUDE.md rule 6). Never log the message: it holds a one-time link.
      await mailer().send(message);
      log.info('invite email sent');
    },
  }),

  /**
   * Tells one admin of the agency that staff approved or rejected its verification (S1-03, S1-F7), with
   * staff's reason. One job per event and recipient (`jobId`), fair-share group = agency, so a retry
   * re-sends only to the admin whose send failed — never to one who already got it — and never to
   * someone who is no longer an active admin. Identity owns the member list, so it sends agency
   * notices; the decision comes from agencies.
   */
  sendVerificationDecisionEmail: defineJob({
    name: 'identity.sendVerificationDecisionEmail',
    pool: 'email',
    payload: z.object({ eventId: z.uuid(), agencyId: z.uuid(), requestId: z.uuid(), userId: z.uuid() }),
    jobId: (p) => `${p.eventId}.${p.userId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 30_000,
    async run(p, { log }) {
      const { webUrl } = identityConfig();
      if (!webUrl) throw new Error('identity: webUrl is not configured');
      const message = await withSystem('identity.sendVerificationDecisionEmail', async (tx) => {
        const decision = await agencies.getVerificationDecision(tx, p.requestId);
        if (!decision || decision.agencyId !== p.agencyId || decision.status === 'SUBMITTED') return null;
        const admin = (await repo.listAdminRecipients(tx, p.agencyId)).find((a) => a.userId === p.userId);
        if (!admin) return null;
        return renderVerificationDecisionEmail(
          admin,
          { approved: decision.status === 'APPROVED', agency: decision.agencyName, reason: decision.reason },
          new URL(`/${emailLocale(admin.locale)}/verification`, webUrl).href,
        );
      });
      if (!message) {
        log.info('verification decision email skipped (recipient is no longer an active admin)');
        return;
      }
      // Outside the transaction (CLAUDE.md rule 6).
      await mailer().send(message);
      log.info('verification decision email sent');
    },
  }),

  /**
   * Maintenance (S1-F4): deletes email-link tokens that expired or were used more than 7 days ago,
   * in batches of 5,000, each its own short transaction. Runs every 6 hours; idempotent.
   */
  pruneAuthTokens: defineJob({
    name: 'identity.pruneAuthTokens',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 6 * 60 * 60_000,
    attempts: 3,
    timeoutMs: 5 * 60_000,
    async run(_p, { log, signal }) {
      const before = new Date(clock.now().getTime() - TOKEN_RETENTION_MS);
      let total = 0;
      for (;;) {
        const deleted = await withSystem('identity.pruneAuthTokens', (tx) =>
          repo.deleteExpiredTokens(tx, before, PRUNE_BATCH),
        );
        total += deleted;
        if (deleted < PRUNE_BATCH || signal.aborted) break;
      }
      log.info({ deleted: total }, 'auth tokens pruned');
      return { deleted: total };
    },
  }),

  /**
   * API keys (S1-05): writes the "last used" times that feed-api marked in Redis, every minute, in
   * batches of 1,000 (one UPDATE each). Idempotent: a time never moves backwards. A batch lost to a
   * failed write only leaves `last_used_at` older (it is informational).
   */
  flushApiKeyUsage: defineJob({
    name: 'identity.flushApiKeyUsage',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: API_KEYS.USAGE_FLUSH_EVERY_MS,
    attempts: 1,
    timeoutMs: 60_000,
    async run(_p, { log }) {
      const uses = [...(await seen.drain(API_KEY_USAGE_SET)).entries()].map(([id, at]) => ({ id, at }));
      let updated = 0;
      for (let i = 0; i < uses.length; i += USAGE_BATCH) {
        const batch = uses.slice(i, i + USAGE_BATCH);
        updated += await withSystem('identity.flushApiKeyUsage', (tx) => keysRepo.recordApiKeyUse(tx, batch));
      }
      if (uses.length > 0) log.info({ keys: uses.length, updated }, 'api key usage recorded');
      return { keys: uses.length, updated };
    },
  }),

  /**
   * API keys follow their agency's status (S1-03 → S1-05): `api_keys.agency_active` mirrors "VERIFIED"
   * (feed-api cannot read `agencies`), then the agency's cached key lookups are dropped. Reads the
   * current status, so duplicate or out-of-order events converge.
   */
  syncApiKeyAgencyStatus: defineJob({
    name: 'identity.syncApiKeyAgencyStatus',
    pool: 'maintenance',
    payload: z.object({ eventId: z.uuid(), agencyId: z.uuid() }),
    jobId: (p) => p.eventId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 30_000,
    async run(p, { log }) {
      const { active, prefixes } = await withSystem('identity.syncApiKeyAgencyStatus', async (tx) => {
        // Locked FOR SHARE: no status change can commit between this read and the write below, so two
        // jobs (or a job and a key creation) racing each other all end on the current status.
        const isActive = (await agencies.lockAgencyStatus(tx, p.agencyId, 'share')) === 'VERIFIED';
        return { active: isActive, prefixes: await keysRepo.setAgencyActive(tx, p.agencyId, isActive, clock.now()) };
      });
      // After commit, outside the transaction (CLAUDE.md rule 6).
      await Promise.all(prefixes.map((prefix) => cache.delete(apiKeyCacheKey(prefix))));
      log.info({ active, keys: prefixes.length }, 'api keys follow the agency status');
    },
  }),
};

const PRUNE_BATCH = 5_000;
const USAGE_BATCH = 1_000;
