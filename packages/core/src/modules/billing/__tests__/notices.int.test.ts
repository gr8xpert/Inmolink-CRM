import { readFileSync } from 'node:fs';
import { closeDb, withSystem } from '@inmolink/db';
import { loadStackEnv, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFounder, type Founder } from '../../../testing/factories';
import * as billing from '../index';
import * as billingWorker from '../worker';

/** Billing notices to the agency's admins (S13-F22): dunning, Free, and the 3-days-before sweep. */

const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('billing.notices.int.test', fn);

async function agentOf(f: Founder): Promise<string> {
  const userId = newId();
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale)
                         values (${userId}, ${`agent-${userId}@example.com`}, 'x', 'Agent', 'en')`);
    await tx.execute(sql`insert into agency_members (user_id, agency_id, role, name, email)
                         values (${userId}, ${f.agencyId}, 'AGENT', 'Agent', ${`agent-${userId}@example.com`})`);
  });
  return userId;
}

const notesOf = (agencyId: string, type: string) =>
  system(
    async (tx) =>
      (
        await tx.execute<{
          user_id: string;
          link: string | null;
          params: Record<string, unknown>;
          email_pending: boolean;
        }>(
          sql`select user_id, link, params, email_pending from notifications
              where agency_id = ${agencyId}::uuid and type = ${type}`,
        )
      ).rows,
  );

async function grant(f: Founder, kind: 'TRIAL' | 'STAFF', endsInDays: number) {
  const id = newId();
  await system((tx) =>
    tx.execute(sql`insert into billing_plan_grants (id, agency_id, kind, plan_code, starts_at, ends_at, reason)
                   values (${id}::uuid, ${f.agencyId}::uuid, ${kind}::billing_plan_grant_kind, 'pro',
                           now() - interval '10 days', now() + ${`${endsInDays} days`}::interval, 'test')`),
  );
  return id;
}

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
}, 180_000);

afterAll(async () => {
  await closeDb();
});

describe('billing notices (S13-F22)', () => {
  it('[S13-F22] dunning started: the admins get it once, with the grace date and the billing link; agents none', async () => {
    const f = await createFounder();
    const agent = await agentOf(f);
    const p = {
      kind: 'DUNNING' as const,
      eventId: newId(),
      agencyId: f.agencyId,
      occurredAt: new Date().toISOString(),
      graceEndsAt: '2026-11-08T10:00:00.000Z',
    };
    expect(await billingWorker.notifyAdmins(p)).toEqual({ notified: 1 });
    expect(await billingWorker.notifyAdmins(p)).toEqual({ notified: 0 });
    const notes = await notesOf(f.agencyId, 'BILLING_PAYMENT_FAILED');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      user_id: f.userId,
      link: '/billing',
      params: { date: Date.parse('2026-11-08T10:00:00.000Z') },
      email_pending: true,
    });
    expect(notes.some((n) => n.user_id === agent)).toBe(false);
  });

  it('[S13-F22] landing on Free: the admins get it once, agents none', async () => {
    const f = await createFounder();
    await agentOf(f);
    const p = { kind: 'FREE' as const, eventId: newId(), agencyId: f.agencyId, occurredAt: new Date().toISOString() };
    expect(await billingWorker.notifyAdmins(p)).toEqual({ notified: 1 });
    expect(await billingWorker.notifyAdmins(p)).toEqual({ notified: 0 });
    expect((await notesOf(f.agencyId, 'BILLING_PLAN_FREE')).map((n) => n.user_id)).toEqual([f.userId]);
  });

  it('[S13 review] a FREE notice for an agency actually on Pro sends nothing (the plan is read again)', async () => {
    const catalog = JSON.parse(
      readFileSync(new URL('../../../../../../scripts/ops/billing-catalog.json', import.meta.url), 'utf8'),
    ) as { items: billing.CatalogInput[] };
    await system((tx) => billing.upsertCatalog(tx, catalog.items, newId));
    const f = await createFounder();
    await grant(f, 'STAFF', 30); // on Pro until the grant ends
    const p = { kind: 'FREE' as const, eventId: newId(), agencyId: f.agencyId, occurredAt: new Date().toISOString() };
    expect(await billingWorker.notifyAdmins(p)).toEqual({ notified: 0 });
    expect(await notesOf(f.agencyId, 'BILLING_PLAN_FREE')).toHaveLength(0);
  });

  it('[S13-F22] the sweep announces a trial or grant 3 days before it ends, once, to admins only', async () => {
    const soon = await createFounder();
    const later = await createFounder();
    const staff = await createFounder();
    const agent = await agentOf(soon);
    await grant(soon, 'TRIAL', 2);
    await grant(later, 'TRIAL', 9);
    await grant(staff, 'STAFF', 1);
    const first = await billingWorker.noticeEndingGrants();
    expect(first.notified).toBeGreaterThanOrEqual(2);
    await billingWorker.noticeEndingGrants();
    const a = await notesOf(soon.agencyId, 'BILLING_PLAN_ENDING');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ user_id: soon.userId, link: '/billing', params: { kind: 'TRIAL', subject: 'pro' } });
    expect(a.some((n) => n.user_id === agent)).toBe(false);
    expect(await notesOf(later.agencyId, 'BILLING_PLAN_ENDING')).toHaveLength(0);
    expect(await notesOf(staff.agencyId, 'BILLING_PLAN_ENDING')).toHaveLength(1);
  });
});
