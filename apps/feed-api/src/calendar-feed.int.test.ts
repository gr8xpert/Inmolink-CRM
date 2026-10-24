import { gunzipSync } from 'node:zlib';
import { CreateCalendarEventBody, UpdateCalendarEventBody } from '@inmolink/contracts';
import { closeDb, withMemberCtx } from '@inmolink/core';
import * as crm from '@inmolink/core/modules/crm';
import { countQueries, createFounder, type Founder, validateIcs } from '@inmolink/core/test';
import { adminQuery, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

/**
 * Members' ICS feeds over HTTP (S10-06): `GET /v2/calendars/{token}/calendar.ics` — no API key (the token URL is the
 * credential), `text/calendar` with CRLF lines, private to the client for ≤ 15 min with an ETag per encoding (weak since S11-F7)
 * (304), gzip when taken, never indexed; a change shows at the next fetch; a revoked token answers 404.
 */

const RUN = newId().slice(-8);
const KEY = 'test-hmac-key-0123456789abcdef0123456789';
const limited: { rule: string; identity: string }[] = [];
const allow = {
  consume: async (rule: { name: string }, identity: string) => {
    limited.push({ rule: rule.name, identity });
    return { allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 };
  },
  credit: async () => undefined,
  consumeMany: async (checks: readonly unknown[]) =>
    checks.map(() => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0, resetAtMs: 0 })),
} as unknown as RateLimiter;

let app: Awaited<ReturnType<typeof buildApp>>;
let a: Founder;
let token = '';
let eventId = '';
let version = 1;

const as = <T>(fn: Parameters<typeof withMemberCtx<T>>[1]) =>
  withMemberCtx({ userId: a.userId, agencyId: a.agencyId, requestId: newId(), locale: 'en' }, fn);
const url = () => `/v2/calendars/${token}/calendar.ics`;

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:calendar-ics:${RUN}` });
  crm.configureCalendarFeeds({ tokenKey: KEY });
  a = await createFounder();
  const start = new Date(Date.now() + 86_400_000);
  const created = await as((ctx) =>
    crm.createCalendarEvent(
      ctx,
      CreateCalendarEventBody.parse({
        type: 'VIEWING',
        title: `Viewing ${RUN}, Calle Mayor`,
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 3_600_000).toISOString(),
      }),
    ),
  );
  eventId = created.event.id;
  version = created.event.version;
  token = (await as((ctx) => crm.rotateCalendarFeed(ctx))).token;
  app = await buildApp({
    logger: createLogger({ service: 'feed-api-test', level: 'silent' }),
    trustProxy: false,
    docsUi: false,
    checks: {},
    limiter: allow,
  });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeCache();
  await closeDb();
});

describe('[S10-06] ICS feed at a secret URL', () => {
  it('[S10-06] serves text/calendar (CRLF), private for ≤ 15 min with an ETag, gzip when taken, 304 on a match', async () => {
    limited.length = 0;
    const res = await app.inject({ method: 'GET', url: url() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8');
    const cc = String(res.headers['cache-control']);
    expect(cc).toMatch(/^private, max-age=(\d+)/);
    expect(Number(/max-age=(\d+)/.exec(cc)?.[1])).toBeLessThanOrEqual(900);
    expect(res.headers.etag).toMatch(/^W\/"[^"]+"$/);
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers.vary).toBe('Accept-Encoding');
    expect(res.body.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(res.body).toContain(`UID:${eventId}@calendar.inmolink`);
    expect(res.body).toContain('Calle Mayor'.slice(0, 5));
    expect(res.body.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    // the per-token limit counts a hash of the token, never the token
    expect(limited.find((l) => l.rule === 'calendar.ics.token')?.identity).toMatch(/^calendar:/);
    expect(JSON.stringify(limited)).not.toContain(token);

    const again = await app.inject({
      method: 'GET',
      url: url(),
      headers: { 'if-none-match': res.headers.etag as string },
    });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');

    const gz = await app.inject({ method: 'GET', url: url(), headers: { 'accept-encoding': 'gzip' } });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gz.headers.etag).not.toBe(res.headers.etag);
    expect(gunzipSync(gz.rawPayload).toString('utf8')).toBe(res.body);
    // the bytes on the wire, strictly: CRLF, folding, UTF-8 per line, escaping, required properties
    expect(validateIcs(res.rawPayload).problems).toEqual([]);
    expect(validateIcs(gunzipSync(gz.rawPayload)).problems).toEqual([]);
  });

  it('[S10-06] reflects a change at the next fetch: the old ETag no longer matches', async () => {
    const first = await app.inject({ method: 'GET', url: url() });
    const updated = await as((ctx) =>
      crm.updateCalendarEvent(ctx, eventId, UpdateCalendarEventBody.parse({ version, title: `Moved ${RUN}` })),
    );
    version = updated.version;
    const next = await app.inject({
      method: 'GET',
      url: url(),
      headers: { 'if-none-match': first.headers.etag as string },
    });
    expect(next.statusCode).toBe(200);
    expect(next.body).toContain(`SUMMARY:Moved ${RUN}`);
    expect(next.body).toContain('SEQUENCE:1');
  });

  it('[S10-06] the lang parameter picks the type names; a revoked token answers 404 at once', async () => {
    const es = await app.inject({ method: 'GET', url: `${url()}?lang=es` });
    expect(es.body).toContain('CATEGORIES:Visita');
    expect((await app.inject({ method: 'GET', url: `/v2/calendars/${'x'.repeat(43)}/calendar.ics` })).statusCode).toBe(
      404,
    );
    await as((ctx) => crm.revokeCalendarFeed(ctx));
    const gone = await app.inject({ method: 'GET', url: url() });
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toMatchObject({ error: { code: 'CALENDAR_FEED_NOT_FOUND' } });
    expect(String(gone.headers['cache-control'])).not.toMatch(/public/);
  });
});

describe('[S11-F7] 304 before rendering', () => {
  let agent = { userId: '', agencyId: '' };
  let agentToken = '';
  let shared = { id: '', version: 1 };
  const asAgent = <T>(fn: Parameters<typeof withMemberCtx<T>>[1]) =>
    withMemberCtx({ userId: agent.userId, agencyId: agent.agencyId, requestId: newId(), locale: 'en' }, fn);
  const agentUrl = () => `/v2/calendars/${agentToken}/calendar.ics`;
  const get = (headers: Record<string, string> = {}, path = agentUrl()) =>
    app.inject({ method: 'GET', url: path, headers });
  const slot = (h: number) => {
    const start = new Date(Date.now() + h * 3_600_000);
    return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 1_800_000).toISOString() };
  };
  const update = (id: string, body: Parameters<typeof UpdateCalendarEventBody.parse>[0]) =>
    as((ctx) => crm.updateCalendarEvent(ctx, id, UpdateCalendarEventBody.parse(body)));

  beforeAll(async () => {
    agent = { userId: newId(), agencyId: a.agencyId };
    const mail = `feed-agent-${agent.userId}@example.com`;
    await adminQuery(
      `insert into users (id, email, password_hash, name, locale, status) values ($1, $2, 'x', 'Feed Agent', 'en', 'ACTIVE')`,
      [agent.userId, mail],
    );
    await adminQuery(
      `insert into agency_members (agency_id, user_id, role, name, email) values ($1, $2, 'AGENT', 'Feed Agent', $3)`,
      [a.agencyId, agent.userId, mail],
    );
    const created = await as((ctx) =>
      crm.createCalendarEvent(
        ctx,
        CreateCalendarEventBody.parse({
          type: 'MEETING',
          title: `Shared ${RUN}`,
          ...slot(30),
          userIds: [agent.userId],
        }),
      ),
    );
    shared = { id: created.event.id, version: created.event.version };
    await asAgent((ctx) =>
      crm.createCalendarEvent(ctx, CreateCalendarEventBody.parse({ type: 'CALL', title: `Own ${RUN}`, ...slot(40) })),
    );
    agentToken = (await asAgent((ctx) => crm.rotateCalendarFeed(ctx))).token;
  });

  it('[S11-F7] a matching If-None-Match is a 304 from one statement in < 20 ms (no definer read, render or gzip)', async () => {
    for (const encoding of [{}, { 'accept-encoding': 'gzip' }] as Record<string, string>[]) {
      const first = await get(encoding);
      expect(first.statusCode).toBe(200);
      const etag = first.headers.etag as string;
      expect(etag).toMatch(/^W\//);
      // the fingerprint answers the very tag the rendered answer carried (computed in JS from its rows)
      for (let i = 0; i < 3; i += 1) await get({ ...encoding, 'if-none-match': etag }); // warm-up
      const ms: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        let res: Awaited<ReturnType<typeof get>> | undefined;
        const t0 = performance.now();
        const n = await countQueries(async () => {
          res = await get({ ...encoding, 'if-none-match': etag });
        });
        ms.push(performance.now() - t0);
        expect(n).toBe(1);
        expect(res?.statusCode).toBe(304);
        expect(res?.body).toBe('');
        expect(res?.headers.etag).toBe(etag);
        expect(String(res?.headers['cache-control'])).toMatch(/^private, max-age=/);
        expect(res?.headers['x-robots-tag']).toBe('noindex, nofollow');
      }
      // the median: the shared test box runs other suites at the same time (an idle run: ~6 ms, p95 ~8 ms)
      ms.sort((x, y) => x - y);
      expect(ms[Math.floor(ms.length / 2)]).toBeLessThan(20);
    }
  });

  it('[S11-F7] the tag changes on an edit, an attendee removed or added, a cancel, a new event; per language', async () => {
    const tagOf = async (path = agentUrl()) => {
      const res = await get({}, path);
      expect(res.statusCode).toBe(200);
      return res.headers.etag as string;
    };
    const seen: string[] = [await tagOf()];
    const expectNew = async (why: string) => {
      const tag = await tagOf();
      expect(seen, why).not.toContain(tag);
      for (const old of seen) expect((await get({ 'if-none-match': old })).statusCode, why).toBe(200);
      seen.push(tag);
    };
    // the language changes the document (type names): its own tag
    expect(seen).not.toContain(await tagOf(`${agentUrl()}?lang=es`));

    let v = (await update(shared.id, { version: shared.version, title: `Renamed ${RUN}` })).version;
    await expectNew('event edited');
    // the agent removed from the shared event: it leaves their feed (their attendee row is deleted)
    v = (await update(shared.id, { version: v, userIds: [] })).version;
    await expectNew('attendee removed');
    v = (await update(shared.id, { version: v, userIds: [agent.userId] })).version;
    await expectNew('attendee added');
    v = (await update(shared.id, { version: v, status: 'CANCELLED' })).version;
    await expectNew('event cancelled');
    shared.version = v;
    await asAgent((ctx) =>
      crm.createCalendarEvent(ctx, CreateCalendarEventBody.parse({ type: 'CALL', title: `New ${RUN}`, ...slot(50) })),
    );
    await expectNew('event added');
  });

  it('[S11-F7] one event leaving the feed and an older one entering it (same count, no newer update) still changes the tag', async () => {
    const before = (await get()).headers.etag as string;
    // an event the agent does not attend, with the shared event's version, last changed long ago
    const old = await as((ctx) =>
      crm.createCalendarEvent(ctx, CreateCalendarEventBody.parse({ type: 'CALL', title: `Old ${RUN}`, ...slot(60) })),
    );
    await adminQuery(
      `update calendar_events set updated_at = now() - interval '300 days', version = $2 where id = $1`,
      [old.event.id, shared.version],
    );
    // the shared event leaves the agent's feed and the old one enters it, without touching either event row
    await adminQuery(`delete from calendar_event_attendees where event_id = $1 and user_id = $2`, [
      shared.id,
      agent.userId,
    ]);
    await adminQuery(
      `insert into calendar_event_attendees (id, agency_id, event_id, user_id, starts_at)
         select gen_random_uuid(), agency_id, id, $2, starts_at from calendar_events where id = $1`,
      [old.event.id, agent.userId],
    );
    const conditional = await get({ 'if-none-match': before });
    expect(conditional.statusCode).toBe(200);
    expect(conditional.headers.etag).not.toBe(before);
    expect(conditional.body).toContain(`Old ${RUN}`);
  });

  it('[S11-F7] a conditional request for a revoked feed is a 404, never a 304', async () => {
    const etag = (await get()).headers.etag as string;
    await asAgent((ctx) => crm.revokeCalendarFeed(ctx));
    const gone = await get({ 'if-none-match': etag });
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toMatchObject({ error: { code: 'CALENDAR_FEED_NOT_FOUND' } });
  });
});
