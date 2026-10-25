import { REPLAY_SAFE_TYPES, replayClass } from '@inmolink/core/modules/admin';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerSubscriptions } from './subscriptions';

/**
 * The outbox replay policy (S13-03 security review) against the real subscribers: a replay re-runs every subscriber of
 * an event, so a "safe" event may only have projection / cache subscribers, and any event a subscriber turns into mail,
 * a notification, an alert, an AI call, a post or a started job must be refused outright.
 */

/** Subscribers that rebuild a projection or cache from current state (nothing reaches a person). */
const PROJECTION =
  /^(search\.(readModel|index)\.|quality\.recompute\.|websiteApi\.(edge|feed)\.|exports\.feed\.|properties\.overrides\.|taxonomy\.cache\.|agencies\.settingsCache\.|websites\.siteCache\.|media\.objects\.)/;

/** Subscribers that mail, notify, alert, bill, call AI, post, write a timeline or start work. */
const SIDE_EFFECT =
  /email|notify|Notice|Reminder|push|digest|deliver|Alerts|publish|trial|aiFeatures|whiteLabel|social\.|captions|lead\.(promote|received)|run\.start|bulk\.run|import\.start|eraseData|dataExport|listingStudio|crm\.activity|timeline/i;

beforeAll(() => registerSubscriptions());

describe('outbox replay policy (S13-03)', () => {
  it('[S13-03] safe types have projection subscribers only; mailing / notifying / job-starting types are refused', () => {
    const entries = defaultSubscribers.entries();
    const byType = new Map(entries.map((e) => [e.type, e.names]));
    for (const type of REPLAY_SAFE_TYPES) {
      const names = byType.get(type) ?? [];
      for (const name of names) expect(name, `${type} → ${name}`).toMatch(PROJECTION);
    }
    for (const { type, names } of entries) {
      if (names.some((n) => SIDE_EFFECT.test(n))) expect(replayClass(type), type).toBe('REFUSED');
    }
    expect(replayClass('identity.passwordReset.requested')).toBe('REFUSED');
    expect(replayClass('billing.plan.changed')).toBe('REFUSED');
  });
});
