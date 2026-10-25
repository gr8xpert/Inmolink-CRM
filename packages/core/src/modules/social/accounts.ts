import { notificationText } from '@inmolink/contracts';
import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
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
 * `social.revokeAccount` (pool `social`, one per `social.account.disconnected` event, S12-07 review): the app's
 * permissions at Meta are revoked for the account's login — unless another account of the agency was connected with
 * the same login (revoking would cut that one off too) — then the account and its posts are deleted. An account
 * connected again before the job ran is left as it is. Meta refusing the token (already revoked or expired) is fine; an
 * outage retries the job.
 */
export async function revokeAccount(p: {
  agencyId: string;
  accountId: string;
}): Promise<{ revoked: boolean; deleted: boolean }> {
  const found = await withSystem(`social.revokeAccount: ${p.accountId}`, async (tx) => {
    const account = await repo.accountWithTokens(tx, p.accountId);
    if (!account || account.agencyId !== p.agencyId || account.statusReason !== repo.DISCONNECTED) return null;
    const others = await repo.otherUserTokens(tx, account.agencyId, account.id);
    return { account, others };
  });
  if (!found) return { revoked: false, deleted: false };
  const { account, others } = found;
  let revoked = false;
  const app = metaApp();
  if (app && account.userTokenEnc) {
    const token = userTokenCipher.decrypt(account.agencyId, account.id, account.userTokenEnc);
    const shared = others.some(
      (o) => o.userTokenEnc !== null && userTokenCipher.decrypt(account.agencyId, o.id, o.userTokenEnc) === token,
    );
    if (!shared) {
      try {
        await new MetaGraphClient(app, socialConfig().fetchOptions).revokePermissions(token);
        revoked = true;
      } catch (err) {
        if (!(err instanceof MetaError) || err.retryable) throw err;
      }
    }
  }
  const deleted = await withSystem(`social.revokeAccount: delete ${p.accountId}`, (tx) =>
    repo.deleteDisconnected(tx, account.id),
  );
  return { revoked, deleted };
}
