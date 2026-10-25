import { notificationText } from '@inmolink/contracts';
import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { DecryptError } from '@inmolink/platform/crypto';
import * as identity from '../identity';
import * as notifications from '../notifications';
import { metaApp, pageTokenCipher, socialConfig, userTokenCipher } from './config';
import { MetaError, MetaGraphClient } from './meta';
import { needsReconnect } from './publish';
import * as repo from './repo';

/**
 * Token upkeep of connected accounts (S12-07).
 *
 * - `social.checkAccounts` (pool `social`, every 6 hours): ACTIVE accounts whose user token expires within
 *   `TOKEN_CHECK.aheadMs` (and that were not checked in the last `recheckMs`) get a fresh long-lived user token and,
 *   from it, a fresh Page token. Meta refusing the token (expired, revoked, password changed) — or a token already
 *   past its expiry that cannot be refreshed — marks the account NEEDS_RECONNECT, announced once
 *   (`social.account.needsReconnect`). A Meta outage leaves it as it is until the next run. At most
 *   `TOKEN_CHECK.batch` accounts per run; Meta is called outside any transaction.
 * - `social.notifyReconnect` (pool `realtime`, one per `social.account.needsReconnect` event): a
 *   `SOCIAL_ACCOUNT_RECONNECT` notification to each of the agency's active admins (in-app and the e-mail digest),
 *   idempotent (`sourceKey` = the event's id). An account connected again (or removed) before the job ran is not
 *   announced.
 */

export const TOKEN_CHECK = { aheadMs: 7 * 86_400_000, recheckMs: 12 * 3_600_000, batch: 100 } as const;

export async function checkAccounts(opts: { now?: Date } = {}): Promise<{ checked: number; reconnect: number }> {
  const now = opts.now ?? clock.now();
  const ids = await withSystem('social.checkAccounts: due', (tx) =>
    repo.accountsToCheck(
      tx,
      new Date(now.getTime() + TOKEN_CHECK.aheadMs),
      new Date(now.getTime() - TOKEN_CHECK.recheckMs),
      TOKEN_CHECK.batch,
    ),
  );
  const app = metaApp();
  let reconnect = 0;
  for (const id of ids) {
    const account = await withSystem(`social.checkAccounts: ${id}`, (tx) => repo.accountWithTokens(tx, id));
    if (account?.status !== 'ACTIVE') continue;
    const expired = account.tokenExpiresAt !== null && account.tokenExpiresAt.getTime() <= now.getTime();
    const markReconnect = async (reason: string) => {
      const changed = await withSystem(`social.checkAccounts: reconnect ${id}`, (tx) =>
        needsReconnect(tx, account.id, account.agencyId, reason, now),
      );
      if (changed) reconnect += 1;
    };
    if (!app || !account.userTokenEnc) {
      // Nothing to refresh with: once it has expired, the member connects it again.
      if (expired) await markReconnect('TOKEN_EXPIRED');
      continue;
    }
    const client = new MetaGraphClient(app, socialConfig().fetchOptions);
    try {
      const user = await client.longLivedUserToken(
        userTokenCipher.decrypt(account.agencyId, account.id, account.userTokenEnc),
      );
      const pageId = account.pageId ?? account.externalId;
      const page = (await client.pages(user.accessToken)).find((p) => p.id === pageId);
      if (!page) {
        await markReconnect('TOKEN_REVOKED');
        continue;
      }
      await withSystem(`social.checkAccounts: refresh ${id}`, (tx) =>
        repo.updateTokens(
          tx,
          account.id,
          {
            tokenEnc: pageTokenCipher.encrypt(account.agencyId, account.id, page.accessToken),
            userTokenEnc: userTokenCipher.encrypt(account.agencyId, account.id, user.accessToken),
            tokenExpiresAt: user.expiresIn ? new Date(now.getTime() + user.expiresIn * 1_000) : null,
          },
          now,
        ),
      );
    } catch (err) {
      if (!(err instanceof MetaError)) throw err;
      // Refused, or past its expiry whatever the error: reconnect. An outage before expiry: the next run tries again.
      if (err.kind === 'TOKEN_EXPIRED' || expired) await markReconnect('TOKEN_EXPIRED');
    }
  }
  return { checked: ids.length, reconnect };
}

export async function notifyReconnect(p: {
  eventId: string;
  agencyId: string;
  accountId: string;
  occurredAt: string;
}): Promise<{ notified: number }> {
  return withSystem(`social.notifyReconnect: account ${p.accountId}`, async (tx) => {
    const account = await repo.accountWithTokens(tx, p.accountId);
    if (!account || account.agencyId !== p.agencyId || account.status !== 'NEEDS_RECONNECT') return { notified: 0 };
    const admins = (await identity.agencyAdminsOf(tx, [p.agencyId])).get(p.agencyId) ?? [];
    if (admins.length === 0) return { notified: 0 };
    const res = await notifications.raiseNotifications(tx, {
      agencyId: p.agencyId,
      type: 'SOCIAL_ACCOUNT_RECONNECT',
      userIds: admins,
      params: { subject: notificationText(account.name) || account.platform },
      link: '/social',
      sourceKey: `social.reconnect:${p.eventId}`,
      at: new Date(p.occurredAt),
    });
    return { notified: res.notified.length };
  });
}

/**
 * `social.revokeAccount` (pool `social`, one per `social.account.disconnected` event, S12-07 review, S13-F5): the
 * disconnected account and its posts are deleted — its tokens leave our side with it. An account connected again
 * before the job ran is left as it is; a redelivered event finds nothing to delete (and revokes nothing).
 *
 * S13-F5: `DELETE /me/permissions` acts on the Meta *user*, whose login may have connected Pages in other agencies too.
 * The job locks every account of the account's Meta user (any agency): while another one exists — connected, or
 * disconnected and waiting for its own job — this one is just deleted; the last one left revokes the grant with its
 * user token (outside any transaction), then is deleted — in a new transaction that re-locks the user's accounts and
 * marks any ACTIVE one (connected during the Meta call; its tokens just died) NEEDS_RECONNECT, announced. So a user's
 * accounts revoke once, whatever the order of their jobs. While any live account connected before S13-F5 (no user id)
 * exists, nothing is revoked (`social.backfillMetaUsers` fills them in). A token Meta already refuses (or a refused
 * request) leaves nothing to revoke; a Meta outage throws so the job retries — on its last attempt the account is
 * deleted anyway, so a disconnected account's tokens never linger.
 */
export async function revokeAccount(
  p: { agencyId: string; accountId: string },
  opts: { lastAttempt?: boolean } = {},
): Promise<{ deleted: boolean; revoked: boolean }> {
  const found = await withSystem(`social.revokeAccount: ${p.accountId}`, async (tx) => {
    const account = await repo.accountWithTokens(tx, p.accountId);
    if (!account || account.agencyId !== p.agencyId || account.statusReason !== repo.DISCONNECTED) return null;
    if (account.metaUserId !== null && account.userTokenEnc !== null) {
      const accounts = await repo.lockMetaUserAccounts(tx, account.metaUserId);
      const self = accounts.find((a) => a.id === account.id);
      // Connected again, or deleted by a concurrent run, while we waited for the lock.
      if (self?.statusReason !== repo.DISCONNECTED) return null;
      // A live account connected before the Meta user was stored (any agency) may be the same login: not revoked
      // until the backfill has filled them in.
      if (accounts.length === 1 && !(await repo.hasLiveAccountWithoutMetaUser(tx))) {
        return { revoke: true as const, account, userTokenEnc: account.userTokenEnc };
      }
    }
    return { revoke: false as const, deleted: await repo.deleteDisconnected(tx, account.id) };
  });
  if (!found) return { deleted: false, revoked: false };
  if (!found.revoke) return { deleted: found.deleted, revoked: false };
  const { account, userTokenEnc } = found;
  let revoked = false;
  const app = metaApp();
  if (app) {
    try {
      await new MetaGraphClient(app, socialConfig().fetchOptions).revokePermissions(
        userTokenCipher.decrypt(account.agencyId, account.id, userTokenEnc),
      );
      revoked = true;
    } catch (err) {
      if (!(err instanceof MetaError)) throw err;
      if (err.retryable && !opts.lastAttempt) throw err;
    }
  }
  const deleted = await withSystem(`social.revokeAccount: delete ${p.accountId}`, async (tx) => {
    if (revoked && account.metaUserId !== null) {
      // The grant is gone for the whole Meta user: an account of that user connected (or connected again) while the
      // request ran — we only decided to revoke when this was its last one — has dead tokens. The member is told.
      const now = clock.now();
      for (const a of await repo.lockMetaUserAccounts(tx, account.metaUserId)) {
        if (a.status === 'ACTIVE') await needsReconnect(tx, a.id, a.agencyId, 'TOKEN_REVOKED', now);
      }
    }
    return repo.deleteDisconnected(tx, account.id);
  });
  return { deleted, revoked };
}

/** Accounts looked up per backfill run (one Meta call each, outside any transaction). */
export const META_USER_BACKFILL = { batch: 100 } as const;

/**
 * `social.backfillMetaUsers` (pool `social`, hourly, S13-F5 review): accounts connected before the Meta user was
 * stored get it from `GET /me` with their own (encrypted) user token. A token Meta refuses is left empty (and tried
 * last next time); a Meta outage stops the run. Until none is left, `revokeAccount` never revokes. Idempotent.
 */
export async function backfillMetaUsers(opts: { now?: Date } = {}): Promise<{ checked: number; filled: number }> {
  const now = opts.now ?? clock.now();
  const app = metaApp();
  if (!app) return { checked: 0, filled: 0 };
  const ids = await withSystem('social.backfillMetaUsers: due', (tx) =>
    repo.accountsWithoutMetaUser(tx, META_USER_BACKFILL.batch),
  );
  const client = new MetaGraphClient(app, socialConfig().fetchOptions);
  let filled = 0;
  for (const id of ids) {
    const account = await withSystem(`social.backfillMetaUsers: ${id}`, (tx) => repo.accountWithTokens(tx, id));
    if (!account?.userTokenEnc || account.metaUserId !== null) continue;
    let metaUserId: string | null = null;
    try {
      metaUserId = await client.userId(userTokenCipher.decrypt(account.agencyId, account.id, account.userTokenEnc));
    } catch (err) {
      // A token we cannot decrypt (a retired key) is as unusable as one Meta refuses.
      if (err instanceof DecryptError) metaUserId = null;
      else if (!(err instanceof MetaError)) throw err;
      else if (err.retryable) break;
    }
    await withSystem(`social.backfillMetaUsers: store ${id}`, (tx) => repo.setMetaUser(tx, id, metaUserId, now));
    if (metaUserId) filled += 1;
  }
  return { checked: ids.length, filled };
}
