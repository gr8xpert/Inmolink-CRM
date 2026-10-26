import { FREE_PLAN, notificationText } from '@inmolink/contracts';
import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import * as identity from '../identity';
import * as notifications from '../notifications';
import * as repo from './repo';
import { planOf } from './service';

/**
 * S13-F22: billing notices to the agency's active admins (in-app and the e-mail digest, EN/ES from the notifications
 * catalog; members who are not admins get none). Worker-only entry (`billing/worker`): it imports `identity`, which
 * imports billing's public `index.ts`.
 *
 * - `billing.notifyAdmins` (pool `realtime`, one per event, job ID = kind + event id):
 *   `billing.dunning.started` → `BILLING_PAYMENT_FAILED` (the grace end date, link to the billing page);
 *   `billing.plan.changed` landing on Free → `BILLING_PLAN_FREE`. Idempotent: `sourceKey` = the event's id. S13 review:
 *   the event is only a trigger — the plan in force is read again (`planOf`) and nothing is sent unless the agency is
 *   really on Free now (a forged or stale event tells no one).
 * - `billing.noticeEndingGrants` (pool `maintenance`, daily): `BILLING_PLAN_ENDING` for trials and staff grants that
 *   end within 3 days. Idempotent without a column: `sourceKey` = the grant's id and `at` = a time fixed by the grant
 *   (3 days before its end, not before its start), so a later sweep raises nothing more. A subscribed agency is not told.
 */

/** How long before a grant's end the admins hear about it. */
export const GRANT_NOTICE_MS = 3 * 86_400_000;
/** Grants read per statement of the sweep (each is announced in its own transaction). */
const SWEEP_BATCH = 200;
const BILLING_LINK = '/billing';

const day = (d: Date | string) => new Date(d).getTime();

export const NoticeInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('DUNNING'),
    eventId: z.uuid(),
    agencyId: z.uuid(),
    occurredAt: z.iso.datetime(),
    graceEndsAt: z.iso.datetime(),
  }),
  z.object({ kind: z.literal('FREE'), eventId: z.uuid(), agencyId: z.uuid(), occurredAt: z.iso.datetime() }),
]);
export type NoticeInput = z.infer<typeof NoticeInput>;

export async function notifyAdmins(p: NoticeInput): Promise<{ notified: number }> {
  return withSystem(`billing.notifyAdmins: ${p.kind} agency ${p.agencyId}`, async (tx) => {
    if (p.kind === 'FREE' && (await planOf(tx, p.agencyId)).code !== FREE_PLAN) return { notified: 0 };
    const admins = (await identity.agencyAdminsOf(tx, [p.agencyId])).get(p.agencyId) ?? [];
    if (admins.length === 0) return { notified: 0 };
    const res = await notifications.raiseNotifications(tx, {
      agencyId: p.agencyId,
      type: p.kind === 'DUNNING' ? 'BILLING_PAYMENT_FAILED' : 'BILLING_PLAN_FREE',
      userIds: admins,
      params: p.kind === 'DUNNING' ? { date: day(p.graceEndsAt) } : {},
      link: BILLING_LINK,
      sourceKey: `billing.${p.kind === 'DUNNING' ? 'dunning' : 'free'}:${p.eventId}`,
      at: new Date(p.occurredAt),
    });
    return { notified: res.notified.length };
  });
}

/** Announces the grants ending within 3 days (`now` for tests). Answers the grants seen and the notifications raised. */
export async function noticeEndingGrants(
  opts: { now?: Date; signal?: AbortSignal } = {},
): Promise<{ grants: number; notified: number }> {
  const now = opts.now ?? clock.now();
  const to = new Date(now.getTime() + GRANT_NOTICE_MS);
  let afterId: string | null = null;
  let grants = 0;
  let notified = 0;
  for (;;) {
    const page = await withSystem('billing.noticeEndingGrants: due', async (tx) => {
      const rows = await repo.grantsEndingBetween(tx, now, to, afterId, SWEEP_BATCH);
      const admins = await identity.agencyAdminsOf(tx, [...new Set(rows.map((r) => r.agencyId))]);
      return { rows, admins };
    });
    for (const g of page.rows) {
      const userIds = page.admins.get(g.agencyId) ?? [];
      if (userIds.length === 0) continue;
      const at = new Date(Math.max(g.startsAt.getTime(), g.endsAt.getTime() - GRANT_NOTICE_MS));
      const res = await withSystem(`billing.noticeEndingGrants: grant ${g.id}`, (tx) =>
        notifications.raiseNotifications(tx, {
          agencyId: g.agencyId,
          type: 'BILLING_PLAN_ENDING',
          userIds,
          params: { subject: notificationText(g.planCode), kind: g.kind, date: day(g.endsAt) },
          link: BILLING_LINK,
          sourceKey: `billing.ending:${g.id}`,
          at,
        }),
      );
      notified += res.notified.length;
    }
    grants += page.rows.length;
    afterId = page.rows.at(-1)?.id ?? null;
    if (page.rows.length < SWEEP_BATCH || opts.signal?.aborted) break;
  }
  return { grants, notified };
}

export const billingNoticeJobs = {
  notifyAdmins: defineJob({
    name: 'billing.notifyAdmins',
    pool: 'realtime',
    payload: NoticeInput,
    jobId: (p) => `billing.notifyAdmins:${p.kind}:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 30_000,
    async run(p) {
      return notifyAdmins(p);
    },
  }),

  noticeEndingGrants: defineJob({
    name: 'billing.noticeEndingGrants',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 24 * 60 * 60_000,
    attempts: 3,
    timeoutMs: 5 * 60_000,
    async run(_p, { log, signal }) {
      const res = await noticeEndingGrants({ signal });
      if (res.notified) log.info(res, 'ending plan grants announced');
      return res;
    },
  }),
};
