import {
  CreateActivityBody,
  CreateContactBody,
  CreateLeadBody,
  type CreateSiteInput,
  ResponseTimeQuery,
} from '@inmolink/contracts';
import { closeDb, countQueries, withIntake, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as websites from '../../websites';
import * as crm from '../index';

/**
 * Response-time KPI (S10-09, PLAN §3 #60): the first human response of a lead (a logged e-mail / call / meeting, a
 * status or stage change by a member; never the system) and the agency's and members' medians. Business-hours-agnostic.
 */

const RUN = newId().slice(-8).toLowerCase();
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('crm.response.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

let a: Founder;
let agent1: string;
let agent2: string;
const as = <T>(userId: string, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId, agencyId: a.agencyId, requestId: newId(), locale: 'en' }, fn);

const HOUR = 3_600_000;
/** The lead's `created_at` in the scenarios: far enough back for every offset, never in the future. */
const T0 = Date.now() - 3 * HOUR;
const at = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000).toISOString();

async function newMember(label: string): Promise<string> {
  const id = newId();
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${id}, ${`resp-${label}-${id}@example.com`}, 'x', ${`Agent ${label}`}, 'en', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${a.agencyId}, ${id}, 'AGENT', ${`Agent ${label}`}, ${`resp-${label}-${id}@example.com`})`);
  });
  return id;
}

/** A lead of a measured source (`PORTAL`, or `MANUAL` which is not measured) received at `createdAt`. */
async function newLead(createdAt: Date, source: 'PORTAL' | 'MANUAL' = 'PORTAL') {
  const contact = (
    await as(agent1, (ctx) =>
      crm.createContact(
        ctx,
        CreateContactBody.parse({ firstName: 'Kpi', emails: [`kpi-${newId()}-${RUN}@example.com`] }),
      ),
    )
  ).contact;
  const { lead } = await as(agent1, (ctx) =>
    crm.createLead(ctx, CreateLeadBody.parse({ contactId: contact.id, source, assignedUserId: null })),
  );
  await system((tx) => tx.execute(sql`update leads set created_at = ${createdAt.toISOString()} where id = ${lead.id}`));
  return lead;
}

const stateOf = async (id: string) =>
  (
    await rows<{
      first_human_response_at: Date | null;
      first_responder_user_id: string | null;
      response_seconds: number | null;
      auto_ack_sent_at: Date | null;
    }>(
      sql`select first_human_response_at, first_responder_user_id, response_seconds, auto_ack_sent_at from leads where id = ${id}`,
    )
  )[0];

const log = (userId: string, leadId: string, type: string, occurredAt: string) =>
  as(userId, (ctx) => crm.logActivity(ctx, CreateActivityBody.parse({ leadId, type, occurredAt, body: 'x' })));

type Step =
  | { do: 'ack'; at: number }
  | { do: 'call' | 'email' | 'meeting' | 'viewing' | 'note'; by: 1 | 2; at: number }
  | { do: 'status'; by: 1 | 2 }
  | { do: 'reorder'; by: 1 | 2 }
  | { do: 'assign'; by: 1 | 2 }
  | { do: 'systemActivity' };

const who = (n: 1 | 2) => (n === 1 ? agent1 : agent2);

beforeAll(async () => {
  await setupTestDb('worker');
  a = await createFounder();
  agent1 = await newMember('one');
  agent2 = await newMember('two');
}, 120_000);

afterAll(async () => {
  await closeDb();
});

describe('first human response', () => {
  const scenarios: {
    name: string;
    steps: Step[];
    /** Expected `response_seconds` (null: no human response) and the responder. */
    seconds: number | null;
    by?: 1 | 2;
    ack?: boolean;
  }[] = [
    { name: 'auto-ack only: no human response', steps: [{ do: 'ack', at: 5 }], seconds: null, ack: true },
    {
      name: 'a call before the e-mail wins',
      steps: [
        { do: 'call', by: 1, at: 120 },
        { do: 'email', by: 2, at: 300 },
      ],
      seconds: 120,
      by: 1,
    },
    {
      name: 'the e-mail logged first but dated later loses to an earlier call logged afterwards (earliest wins)',
      steps: [
        { do: 'email', by: 2, at: 300 },
        { do: 'call', by: 1, at: 60 },
      ],
      seconds: 60,
      by: 1,
    },
    {
      name: 'the system’s activities and the auto-ack are not a response',
      steps: [{ do: 'ack', at: 3 }, { do: 'systemActivity' }],
      seconds: null,
      ack: true,
    },
    { name: 'a status change by a member answers (set once)', steps: [{ do: 'status', by: 2 }], seconds: -1, by: 2 },
    {
      name: 'a status change after a call keeps the call',
      steps: [
        { do: 'meeting', by: 1, at: 45 },
        { do: 'status', by: 2 },
      ],
      seconds: 45,
      by: 1,
    },
    { name: 'a reorder inside the column is not a response', steps: [{ do: 'reorder', by: 1 }], seconds: null },
    { name: 'an assignment alone is not a response', steps: [{ do: 'assign', by: 1 }], seconds: null },
    {
      name: 'a viewing or a note is not a response',
      steps: [
        { do: 'viewing', by: 1, at: 30 },
        { do: 'note', by: 1, at: 40 },
      ],
      seconds: null,
    },
    {
      name: 'an answer dated before the lead reached the inbox is taken as given when logged (never 0 s)',
      steps: [{ do: 'call', by: 1, at: -90 }],
      seconds: -1,
      by: 1,
    },
  ];

  it.each(scenarios)('[S10-09] $name', async (s) => {
    const lead = await newLead(new Date(T0));
    for (const step of s.steps) {
      if (step.do === 'ack') {
        await system((tx) => tx.execute(sql`update leads set inbound_lead_id = ${newId()} where id = ${lead.id}`));
        const inbound = (
          await rows<{ inbound: string }>(sql`select inbound_lead_id as inbound from leads where id = ${lead.id}`)
        )[0]?.inbound;
        await crm.recordAutoAck({
          agencyId: a.agencyId,
          inboundLeadId: inbound as string,
          at: new Date(T0 + step.at * 1000),
        });
      } else if (step.do === 'call' || step.do === 'email' || step.do === 'meeting' || step.do === 'viewing') {
        await log(who(step.by), lead.id, step.do.toUpperCase(), at(step.at));
      } else if (step.do === 'note') {
        await log(who(step.by), lead.id, 'OTHER', at(step.at));
      } else if (step.do === 'status') {
        const current = await as(who(step.by), (ctx) => crm.getLead(ctx, lead.id));
        await as(who(step.by), (ctx) =>
          crm.updateLead(ctx, lead.id, { version: current.version, status: 'IN_PROGRESS' }),
        );
      } else if (step.do === 'reorder') {
        const current = await as(who(step.by), (ctx) => crm.getLead(ctx, lead.id));
        await as(who(step.by), (ctx) =>
          crm.moveLead(ctx, lead.id, { version: current.version, stageId: current.stageId, afterLeadId: null }),
        );
      } else if (step.do === 'assign') {
        const current = await as(who(step.by), (ctx) => crm.getLead(ctx, lead.id));
        await as(who(step.by), (ctx) =>
          crm.updateLead(ctx, lead.id, { version: current.version, assignedUserId: agent2 }),
        );
      } else {
        // an outbox-written activity (promotion, a stage change recorded from its event): never a response
        for (const type of ['LEAD_CREATED', 'STAGE_CHANGED'] as const) {
          await crm.recordActivity({
            eventId: newId(),
            agencyId: a.agencyId,
            occurredAt: at(10),
            type,
            leadId: lead.id,
            data: {},
          });
        }
      }
    }
    const state = await stateOf(lead.id);
    if (s.seconds === null) {
      expect(state?.first_human_response_at).toBeNull();
      expect(state?.response_seconds).toBeNull();
      expect(state?.first_responder_user_id).toBeNull();
    } else if (s.seconds === -1) {
      // a status change happens "now": three hours after the lead
      expect(state?.response_seconds).toBeGreaterThanOrEqual(3 * 3_600);
      expect(state?.response_seconds).toBeLessThan(3 * 3_600 + 120);
    } else {
      expect(state?.response_seconds).toBe(s.seconds);
    }
    if (s.by) expect(state?.first_responder_user_id).toBe(who(s.by));
    if (s.ack) expect(state?.auto_ack_sent_at).not.toBeNull();
    else expect(state?.auto_ack_sent_at).toBeNull();
  });

  it('[S10-09] a second answer, replayed or later, never changes the first', async () => {
    const lead = await newLead(new Date(T0));
    await log(agent1, lead.id, 'CALL', at(100));
    const first = await stateOf(lead.id);
    await log(agent1, lead.id, 'CALL', at(100));
    await log(agent2, lead.id, 'EMAIL', at(500));
    const current = await as(agent2, (ctx) => crm.getLead(ctx, lead.id));
    await as(agent2, (ctx) => crm.updateLead(ctx, lead.id, { version: current.version, status: 'LOST' }));
    expect(await stateOf(lead.id)).toEqual(first);
    expect(first?.response_seconds).toBe(100);
  });

  it('[S10-09] logging a call costs one extra statement and a status change none', async () => {
    const lead = await newLead(new Date(T0));
    const logged = await countQueries(() => log(agent1, lead.id, 'CALL', at(10)));
    const baseline = await countQueries(() => log(agent1, lead.id, 'OTHER', at(20)));
    expect(logged).toBe(baseline + 1);
    const other = await newLead(new Date(T0));
    const v = (await as(agent1, (ctx) => crm.getLead(ctx, other.id))).version;
    const withResponse = await countQueries(() =>
      as(agent1, (ctx) => crm.updateLead(ctx, other.id, { version: v, status: 'IN_PROGRESS' })),
    );
    const third = await newLead(new Date(T0));
    const v3 = (await as(agent1, (ctx) => crm.getLead(ctx, third.id))).version;
    const assignOnly = await countQueries(() =>
      as(agent1, (ctx) => crm.updateLead(ctx, third.id, { version: v3, assignedUserId: agent2 })),
    );
    // a status change also moves the stage (reads it) and emits an event; the response itself rides on the update
    expect(withResponse).toBeLessThanOrEqual(assignOnly + 3);
  });
});

describe('first response: drag and concurrency', () => {
  it('[S10-09] dragging a lead into another stage counts as that member’s response', async () => {
    const lead = await newLead(new Date(T0));
    const current = await as(agent2, (ctx) => crm.getLead(ctx, lead.id));
    const target = (await as(agent2, (ctx) => crm.listPipelineStages(ctx, {}))).items.find(
      (s) => s.id !== current.stageId,
    );
    expect(target).toBeDefined();
    await as(agent2, (ctx) =>
      crm.moveLead(ctx, lead.id, { version: current.version, stageId: target?.id as string, afterLeadId: null }),
    );
    const state = await stateOf(lead.id);
    expect(state?.first_responder_user_id).toBe(agent2);
    expect(state?.response_seconds).toBeGreaterThanOrEqual(3 * 3_600);
  });

  it('[S10-09] two concurrent logged responses keep the earlier occurredAt, whichever commits first', async () => {
    for (const order of [
      [400, 200],
      [200, 400],
    ] as const) {
      const lead = await newLead(new Date(T0));
      await Promise.all([log(agent1, lead.id, 'CALL', at(order[0])), log(agent2, lead.id, 'EMAIL', at(order[1]))]);
      const state = await stateOf(lead.id);
      expect(state?.response_seconds).toBe(200);
      expect(state?.first_responder_user_id).toBe(order[0] === 200 ? agent1 : agent2);
    }
  });

  it('[S10-09] a response dated before the lead existed is taken as logged-now and displaces nothing earlier', async () => {
    const lead = await newLead(new Date(T0));
    await log(agent1, lead.id, 'CALL', at(-500));
    expect((await stateOf(lead.id))?.response_seconds).toBeGreaterThanOrEqual(3 * 3_600);
    const other = await newLead(new Date(T0));
    await log(agent1, other.id, 'CALL', at(30));
    await log(agent2, other.id, 'EMAIL', at(-500));
    // the back-dated entry reads as logged now, so the real 30 s answer stands (recorded trade-off)
    expect((await stateOf(other.id))?.response_seconds).toBe(30);
    expect((await stateOf(other.id))?.first_responder_user_id).toBe(agent1);
  });
});

describe('response time KPI', () => {
  /** Case `i` lives on day `i` of a window starting 60 days back; one case is one day. */
  const base = Date.now() - 60 * 24 * HOUR;
  const day = (i: number) => ({
    from: new Date(base + i * 24 * HOUR),
    to: new Date(base + (i + 1) * 24 * HOUR),
  });
  const q = (i: number) => ResponseTimeQuery.parse({ from: day(i).from.toISOString(), to: day(i).to.toISOString() });

  /** Leads received on day `i`; `answers` are `[seconds, responder]`, null: unanswered. */
  async function seed(i: number, answers: ([number, 1 | 2] | null)[], source: 'PORTAL' | 'MANUAL' = 'PORTAL') {
    for (const [n, answer] of answers.entries()) {
      const created = new Date(day(i).from.getTime() + (n + 1) * 60_000);
      const lead = await newLead(created, source);
      if (answer) {
        const [seconds, by] = answer;
        await system((tx) =>
          tx.execute(sql`update leads set first_human_response_at = ${new Date(created.getTime() + seconds * 1000).toISOString()},
            response_seconds = ${seconds}, first_responder_user_id = ${who(by)} where id = ${lead.id}`),
        );
      }
    }
  }

  const kpi = (i: number) => as(agent1, (ctx) => crm.getResponseTimeKpi(ctx, q(i)));

  it('[S10-09] median of an odd number of responses is the middle one', async () => {
    await seed(0, [
      [90, 1],
      [10, 1],
      [20, 1],
    ]);
    const r = await kpi(0);
    expect(r).toMatchObject({ leads: 3, responded: 3, medianSeconds: 20, avgSeconds: 40 });
    expect(r.agents).toMatchObject([{ userId: agent1, name: 'Agent one', responded: 3, medianSeconds: 20 }]);
  });

  it('[S10-09] median of an even number averages the two middle ones', async () => {
    await seed(1, [
      [10, 1],
      [20, 1],
      [90, 2],
      [100, 2],
    ]);
    const r = await kpi(1);
    expect(r).toMatchObject({ leads: 4, responded: 4, medianSeconds: 55 });
    // fastest median first: agent one (15 s) before agent two (95 s)
    expect(r.agents.map((x) => [x.userId, x.medianSeconds, x.responded])).toEqual([
      [agent1, 15, 2],
      [agent2, 95, 2],
    ]);
  });

  it('[S10-09] unanswered leads are counted but stay out of the medians', async () => {
    await seed(2, [[10, 1], [20, 2], null, null]);
    const r = await kpi(2);
    expect(r).toMatchObject({ leads: 4, responded: 2, medianSeconds: 15, avgSeconds: 15 });
  });

  it('[S10-09] no response at all: a null median, not zero', async () => {
    await seed(3, [null, null]);
    expect(await kpi(3)).toMatchObject({ leads: 2, responded: 0, medianSeconds: null, avgSeconds: null, agents: [] });
    expect(await kpi(4)).toMatchObject({ leads: 0, responded: 0, medianSeconds: null, agents: [] });
  });

  it('[S10-09] hand-entered (MANUAL) leads are not measured', async () => {
    await seed(5, [[5, 1]], 'MANUAL');
    await seed(5, [[40, 1]]);
    expect(await kpi(5)).toMatchObject({ leads: 1, responded: 1, medianSeconds: 40 });
  });

  it('[S10-09] a range counts the leads received in it, by received time', async () => {
    const wide = ResponseTimeQuery.parse({ from: day(0).from.toISOString(), to: day(3).to.toISOString() });
    const r = await as(agent1, (ctx) => crm.getResponseTimeKpi(ctx, wide));
    expect(r.leads).toBe(3 + 4 + 4 + 2);
    expect(r.responded).toBe(3 + 4 + 2);
  });

  it('[S10-09] one query for the numbers (plus the names), range capped at 92 days', async () => {
    const setup = await countQueries(() => as(agent1, async () => null));
    const count = (await countQueries(() => kpi(1))) - setup;
    expect(count).toBeLessThanOrEqual(2);
    const from = new Date(base);
    expect(() =>
      ResponseTimeQuery.parse({
        from: from.toISOString(),
        to: new Date(from.getTime() + 93 * 24 * HOUR).toISOString(),
      }),
    ).toThrow();
    expect(() =>
      ResponseTimeQuery.parse({
        from: from.toISOString(),
        to: new Date(from.getTime() + 92 * 24 * HOUR).toISOString(),
      }),
    ).not.toThrow();
  });

  it('[S10-09] another agency sees none of it', async () => {
    const other = await createFounder();
    const r = await withMemberCtx(
      { userId: other.userId, agencyId: other.agencyId, requestId: newId(), locale: 'en' },
      (ctx) => crm.getResponseTimeKpi(ctx, q(1)),
    );
    expect(r).toMatchObject({ leads: 0, responded: 0, agents: [] });
  });
});

describe('automatic acknowledgement and promotion', () => {
  let siteId: string;

  beforeAll(async () => {
    const site: CreateSiteInput = {
      name: 'Kpi Homes web',
      domains: [`www.kpi-homes-${RUN}.example`],
      mode: 'WP_PLUGIN',
      inventoryPolicy: 'OWN_ONLY',
      inventoryFilters: null,
      referencePrefix: 'KP',
      locales: ['en', 'es'],
      contact: { name: 'Kpi Homes', email: 'office@kpi-homes.example', phone: '+34 600 000 003' },
    };
    siteId = (await as(a.userId, (ctx) => websites.createSite(ctx, site))).id;
  });

  async function inbound(): Promise<string> {
    const id = newId();
    await withIntake({ agencyId: a.agencyId }, (tx) =>
      websites.recordInboundLead(tx, {
        id,
        agencyId: a.agencyId,
        siteId,
        kind: 'ENQUIRY',
        idempotencyHash: `idem-${id}`,
        requestHash: 'x',
        verification: 'SERVER_KEY',
        target: null,
        locale: 'en',
        name: 'Vera Visitor',
        email: `visitor-${id.slice(-6)}-${RUN}@example.com`,
        emailHash: `h-${id}`,
        keyTier: 'STANDARD',
        phone: null,
        message: 'Hello',
        viewingSlots: null,
        marketingConsent: true,
        pageUrl: null,
      }),
    );
    return id;
  }
  const leadOf = async (inboundId: string) =>
    (await rows<{ id: string }>(sql`select id from leads where inbound_lead_id = ${inboundId}`))[0]?.id as string;

  it('[S10-09] an acknowledgement sent before promotion is copied; one sent after is recorded; neither is a response', async () => {
    const early = await inbound();
    const earlyAt = new Date(Date.now() - 60_000);
    await system((tx) => websites.markLeadSent(tx, early, 'ack', earlyAt));
    await crm.promoteInboundLead({ agencyId: a.agencyId, inboundLeadId: early });
    const s1 = await stateOf(await leadOf(early));
    expect(new Date(s1?.auto_ack_sent_at as unknown as string).toISOString()).toBe(earlyAt.toISOString());
    expect(s1?.first_human_response_at).toBeNull();

    const late = await inbound();
    await crm.promoteInboundLead({ agencyId: a.agencyId, inboundLeadId: late });
    expect((await stateOf(await leadOf(late)))?.auto_ack_sent_at).toBeNull();
    const lateAt = new Date();
    expect(await crm.recordAutoAck({ agencyId: a.agencyId, inboundLeadId: late, at: lateAt })).toBe(1);
    const s2 = await stateOf(await leadOf(late));
    expect(new Date(s2?.auto_ack_sent_at as unknown as string).toISOString()).toBe(lateAt.toISOString());
    expect(s2?.first_human_response_at).toBeNull();
    // before promotion (or for an unknown lead) it is a no-op
    expect(await crm.recordAutoAck({ agencyId: a.agencyId, inboundLeadId: newId(), at: lateAt })).toBe(0);
    // a website lead is measured: it counts in the KPI as unanswered
    const now = Date.now();
    const r = await as(agent1, (ctx) =>
      crm.getResponseTimeKpi(
        ctx,
        ResponseTimeQuery.parse({
          from: new Date(now - HOUR).toISOString(),
          to: new Date(now + HOUR).toISOString(),
        }),
      ),
    );
    expect(r.leads).toBeGreaterThanOrEqual(2);
  });
});
