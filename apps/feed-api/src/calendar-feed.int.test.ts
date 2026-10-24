import { gunzipSync } from 'node:zlib';
import { CreateCalendarEventBody, UpdateCalendarEventBody } from '@inmolink/contracts';
import { closeDb, withMemberCtx } from '@inmolink/core';
import * as crm from '@inmolink/core/modules/crm';
import { createFounder, type Founder, validateIcs } from '@inmolink/core/test';
import { setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

/**
 * Members' ICS feeds over HTTP (S10-06): `GET /v2/calendars/{token}/calendar.ics` — no API key (the token URL is the
 * credential), `text/calendar` with CRLF lines, private to the client for ≤ 15 min with a strong ETag per encoding
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
  it('[S10-06] serves text/calendar (CRLF), private for ≤ 15 min with a strong ETag, gzip when taken, 304 on a match', async () => {
    limited.length = 0;
    const res = await app.inject({ method: 'GET', url: url() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8');
    const cc = String(res.headers['cache-control']);
    expect(cc).toMatch(/^private, max-age=(\d+)/);
    expect(Number(/max-age=(\d+)/.exec(cc)?.[1])).toBeLessThanOrEqual(900);
    expect(res.headers.etag).toMatch(/^"[^"]+"$/);
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
