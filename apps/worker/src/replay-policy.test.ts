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
  /^(search\.(readModel|index)\.|quality\.recompute\.|websiteApi\.(edge|feed|portal)\.|properties\.overrides\.|taxonomy\.cache\.|agencies\.settingsCache\.|websites\.siteCache\.|media\.objects\.|onboarding\.progress\.)/;

/**
 * Subscribers that call an outside system (S13 review): a portal feed pass (`exports.feed.*`) queues
 * `exports.pushPortalListings` (idealista / Fotocasa API calls), so it is not a projection and its events are never SAFE.
 */
const EXTERNAL_PUSH = /^exports\.feed\./;

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

  it('[S13 review] events with a portal-push-queuing subscriber are never SAFE', () => {
    const entries = defaultSubscribers.entries();
    const pushing = entries.filter((e) => e.names.some((n) => EXTERNAL_PUSH.test(n)));
    expect(pushing.length).toBeGreaterThan(0);
    for (const { type, names } of pushing) expect(replayClass(type), `${type} (${names.join(', ')})`).not.toBe('SAFE');
    for (const type of ['exports.connection.changed', 'imports.run.finished', 'properties.listing.updated']) {
      expect(replayClass(type), type).toBe('SUPER_ADMIN');
    }
  });
});
