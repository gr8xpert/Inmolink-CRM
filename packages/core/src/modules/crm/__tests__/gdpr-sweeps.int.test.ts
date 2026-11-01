import {
  CreateActivityBody,
  CreateCalendarEventBody,
  CreateContactBody,
  CreateContactNoteBody,
  CreateLeadBody,
  CreateProspectBody,
  CreateTaskBody,
} from '@inmolink/contracts';
import { closeDb, withSystem, withTenant } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as compliance from '../../compliance';
import * as crm from '../index';
import { agencySpreadOf, RETENTION_SWEEP_SPREAD_MS } from '../jobs';
import * as repo from '../repo';

/**
 * S17-F3 (S16 perf review): the GDPR sweeps read bounded pages. Agency erasure's text sweep walks each table on its
 * index keyset (a cleared row is never read again: no statement scans past what earlier ones cleared); the retention
 * scan pages candidates on `contacts_retention_idx` (a kept contact is read once a run); the daily retention runs are
 * spread per agency. Timings and plans on the scale data: tests/perf/gdpr-sweeps.int.test.ts.
 */

const RUN = newId().slice(-8).toLowerCase();
const log = createLogger({ service: 'crm-gdpr-sweeps-test', level: 'silent' });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('crm.gdpr-sweeps.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

let a: Founder;
let b: Founder;
const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

/** Free text in every table the sweep clears: `n` of each (tasks and prospects: some deleted). */
async function seedText(m: Founder, n: number): Promise<void> {
  const tax = await system(async (tx) => {
    const [l] = (await tx.execute<{ id: string }>(sql`select id from locations limit 1`)).rows;
    const [t] = (await tx.execute<{ id: string }>(sql`select id from property_types limit 1`)).rows;
    return { locationId: l?.id as string, propertyTypeId: t?.id as string };
  });
  const { contact } = await as(m, (ctx) =>
    crm.createContact(
      ctx,
      CreateContactBody.parse({ firstName: `Text${RUN}`, emails: [`text-${newId()}@sw.example`] }),
    ),
  );
  for (let i = 0; i < n; i++) {
    await as(m, async (ctx) => {
      await crm.addContactNote(ctx, contact.id, CreateContactNoteBody.parse({ body: `note ${RUN}` }));
      await crm.logActivity(
        ctx,
        CreateActivityBody.parse({ type: 'CALL', contactId: contact.id, body: `call ${RUN}` }),
      );
      await crm.createLead(ctx, CreateLeadBody.parse({ contactId: contact.id, message: `message ${RUN}` }));
      const { task } = await crm.createTask(
        ctx,
        CreateTaskBody.parse({ title: `Task ${RUN}`, description: `d ${RUN}` }),
      );
      if (i % 2 === 0) await crm.deleteTask(ctx, task.id);
      await crm.createCalendarEvent(
        ctx,
        CreateCalendarEventBody.parse({
          type: 'MEETING',
          title: `Meet ${RUN}`,
          description: `d ${RUN}`,
          location: `l ${RUN}`,
          startsAt: new Date(Date.now() + (i + 1) * 86_400_000).toISOString(),
          endsAt: new Date(Date.now() + (i + 1) * 86_400_000 + 3_600_000).toISOString(),
          contactIds: [contact.id],
        }),
      );
      const { prospect } = await crm.createProspect(
        ctx,
        CreateProspectBody.parse({ title: `Villa ${RUN}`, confidentialNotes: `c ${RUN}`, ...tax }),
      );
      if (i % 2 === 0) await crm.deleteProspect(ctx, prospect.id);
    });
  }
}

/** Rows of the agency still holding this run's text, per table. */
const leftText = (agencyId: string) =>
  rows<Record<string, number>>(sql`select
      (select count(*) from activities where agency_id = ${agencyId} and body like ${`%${RUN}%`})::int as activities,
      (select count(*) from tasks where agency_id = ${agencyId} and (title like ${`%${RUN}%`} or description is not null))::int as tasks,
      (select count(*) from calendar_events where agency_id = ${agencyId} and (title like ${`%${RUN}%`} or location is not null))::int as events,
      (select count(*) from seller_prospects where agency_id = ${agencyId} and (title like ${`%${RUN}%`} or confidential_notes is not null))::int as prospects,
      (select count(*) from leads where agency_id = ${agencyId} and message is not null)::int as leads,
      (select count(*) from contact_notes where agency_id = ${agencyId})::int as notes`).then((r) => r[0]);

beforeAll(async () => {
  await setupTestDb('worker');
  [a, b] = await Promise.all([createFounder(), createFounder()]);
}, 60_000);

afterAll(async () => {
  await closeDb();
});

describe('agency text sweep (S17-F3)', () => {
  it('[S17-F3] clearAgencyText walks each table on a keyset: every row cleared, none read twice, other agencies untouched', async () => {
    const N = 5;
    await seedText(a, N);
    await seedText(b, 2);
    const before = await leftText(a.agencyId);
    // (a lead and a note log activities of their own)
    expect(before).toMatchObject({ tasks: N, events: N, prospects: N, leads: N, notes: N });
    expect(before?.activities).toBeGreaterThanOrEqual(N);
    const otherBefore = await leftText(b.agencyId);

    // pages of 2 rows: a step ends on its first short page, so the calls are bounded by the rows walked —
    // Σ (⌊rows / 2⌋ + 1) per step — never by passes over rows already cleared
    const LIMIT = 2;
    const walked = await system(async (tx) => {
      const [r] = (
        await tx.execute<Record<string, number>>(sql`select
          (select count(*) from activities where agency_id = ${a.agencyId})::int as activities,
          (select count(*) from tasks where agency_id = ${a.agencyId} and deleted_at is null)::int as live_tasks,
          (select count(*) from tasks where agency_id = ${a.agencyId} and deleted_at is not null)::int as deleted_tasks,
          (select count(*) from calendar_events where agency_id = ${a.agencyId})::int as events,
          (select count(*) from seller_prospects where agency_id = ${a.agencyId} and deleted_at is null)::int as live_prospects,
          (select count(*) from seller_prospects where agency_id = ${a.agencyId} and deleted_at is not null)::int as deleted_prospects,
          (select count(*) from leads where agency_id = ${a.agencyId})::int as leads,
          (select count(*) from contact_notes where agency_id = ${a.agencyId})::int as notes`)
      ).rows;
      return Object.values(r ?? {});
    });
    expect(walked).toHaveLength(repo.AGENCY_TEXT_STEPS);
    const bound = walked.reduce((s, n) => s + Math.floor(n / LIMIT) + 1, 0);

    let cursor: repo.AgencyTextCursor | null = { step: 0, key: null };
    let calls = 0;
    let changed = 0;
    const steps: number[] = [];
    while (cursor) {
      const c: repo.AgencyTextCursor = cursor;
      const r = await withTenant({ agencyId: a.agencyId }, (tx) => repo.clearAgencyText(tx, a.agencyId, c, LIMIT));
      steps.push(c.step);
      changed += r.rows;
      calls += 1;
      // the cursor only moves forward: the next step, or a later key of the same step (the notes step deletes: no key)
      if (r.next && r.next.step === c.step && c.step < repo.AGENCY_TEXT_STEPS - 1) {
        expect(r.next.key).toBeTruthy();
        if (c.key) expect(r.next.key).not.toEqual(c.key);
      }
      if (r.next) expect(r.next.step).toBeGreaterThanOrEqual(c.step);
      cursor = r.next;
      expect(calls).toBeLessThanOrEqual(bound);
    }
    expect([...new Set(steps)]).toEqual(Array.from({ length: repo.AGENCY_TEXT_STEPS }, (_, i) => i));
    expect(await leftText(a.agencyId)).toEqual({
      activities: 0,
      tasks: 0,
      events: 0,
      prospects: 0,
      leads: 0,
      notes: 0,
    });
    expect(changed).toBeGreaterThanOrEqual(6 * N);
    // the other agency keeps everything
    expect(await leftText(b.agencyId)).toEqual(otherBefore);

    // through the service and its stored (text) cursor: a second sweep finds nothing left and still ends
    let after: string | null = null;
    let more = 0;
    do {
      const r: { rows: number; next: string | null } = await crm.eraseAgencyCrmText({ agencyId: a.agencyId, after });
      expect(r.rows).toBe(0);
      after = r.next;
      more += 1;
    } while (after && more < 50);
    expect(after).toBeNull();
    // a garbled stored cursor restarts the walk instead of failing the operation
    expect((await crm.eraseAgencyCrmText({ agencyId: a.agencyId, after: '{not json' })).rows).toBe(0);
  }, 120_000);
});

describe('retention scan (S17-F3)', () => {
  it('[S17-F3] the retention scan pages candidates oldest first on a keyset: a kept contact is read once a run', async () => {
    await as(a, (ctx) =>
      compliance.setRetentionSettings(ctx, { inactiveContactMonths: 24 }, { verifyStepUp: async () => {} }),
    );
    await system((tx) =>
      tx.execute(sql`update retention_settings set effective_at = now() - interval '1 day', previous_months = null
        where agency_id = ${a.agencyId}`),
    );
    // 5 kept (an open deal each) and 3 inactive, all untouched for three years, the kept ones the oldest
    const make = async (name: string) =>
      (
        await as(a, (ctx) =>
          crm.createContact(
            ctx,
            CreateContactBody.parse({ firstName: name, emails: [`${name}-${newId()}@sw.example`] }),
          ),
        )
      ).contact.id;
    const kept: string[] = [];
    for (let i = 0; i < 5; i++) kept.push(await make(`Kept${i}${RUN}`));
    const idle: string[] = [];
    for (let i = 0; i < 3; i++) idle.push(await make(`Idle${i}${RUN}`));
    for (const id of kept) await as(a, (ctx) => crm.createLead(ctx, CreateLeadBody.parse({ contactId: id })));
    await system(async (tx) => {
      for (const [i, id] of [...kept, ...idle].entries()) {
        await tx.execute(sql`update contacts set updated_at = now() - interval '36 months' + make_interval(secs => ${i}),
            created_at = now() - interval '36 months' where id = ${id}`);
      }
      await tx.execute(sql`update leads set updated_at = now() - interval '36 months'
        where contact_id in (${sql.join(
          kept.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`);
    });
    const cutoff = new Date();
    cutoff.setUTCMonth(cutoff.getUTCMonth() - 24);
    // pages of 2: every candidate read once, in order; kept ones never come back
    const seen: string[] = [];
    const inactive: string[] = [];
    let after: repo.RetentionCursor | null = null;
    for (let page = 0; page < 20; page++) {
      const c: repo.RetentionCursor | null = after;
      const r = await withTenant({ agencyId: a.agencyId }, async (tx) => {
        const res = await repo.inactiveContactsPage(tx, a.agencyId, cutoff, c, 2);
        return res;
      });
      inactive.push(...r.ids);
      if (r.last) seen.push(r.last.id);
      if (!r.last) break;
      after = r.last;
    }
    const ours = new Set([...kept, ...idle]);
    expect(inactive.filter((id) => ours.has(id))).toEqual(idle);
    expect(new Set(seen).size).toBe(seen.length);
    // the job erases exactly the inactive ones
    const erased = await crm.anonymizeInactiveContacts({
      agencyId: a.agencyId,
      months: 24,
      now: new Date(),
      maxContacts: 5_000,
    });
    expect(erased).toBeGreaterThanOrEqual(idle.length);
    const names = await rows<{ id: string; first_name: string | null }>(
      sql`select id, first_name from contacts where id in (${sql.join(
        [...ours].map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
    );
    for (const r of names) expect(r.first_name === null, r.id).toBe(idle.includes(r.id));
  }, 60_000);

  it('[S17-F3] the daily retention runs are spread over 6 hours by agency (stable offsets)', async () => {
    const queued: { agencyId: string; delayMs?: number }[] = [];
    const spy = vi.spyOn(crm.crmJobs.anonymizeInactiveContacts, 'enqueueMany').mockImplementation(async (entries) => {
      for (const e of entries) queued.push({ agencyId: e.payload.agencyId, delayMs: e.options?.delayMs });
      return entries.map(() => ({ id: newId() }));
    });
    try {
      await crm.crmJobs.sweepRetention.spec.run({}, {
        log,
        signal: new AbortController().signal,
        lastAttempt: true,
      } as never);
    } finally {
      spy.mockRestore();
    }
    const mine = queued.find((q) => q.agencyId === a.agencyId);
    expect(mine?.delayMs).toBe(agencySpreadOf(a.agencyId, RETENTION_SWEEP_SPREAD_MS));
    for (const q of queued) {
      expect(q.delayMs).toBeGreaterThanOrEqual(0);
      expect(q.delayMs).toBeLessThan(RETENTION_SWEEP_SPREAD_MS);
    }
    expect(RETENTION_SWEEP_SPREAD_MS).toBe(6 * 3_600_000);
    // evenly spread: offsets of many agencies cover the window
    const offsets = Array.from({ length: 1_000 }, () => agencySpreadOf(newId(), RETENTION_SWEEP_SPREAD_MS));
    const hours = new Set(offsets.map((o) => Math.floor(o / 3_600_000)));
    expect(hours.size).toBe(6);
  });
});
