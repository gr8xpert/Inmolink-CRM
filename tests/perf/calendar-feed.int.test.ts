import { gunzipSync } from 'node:zlib';
import { withMemberCtx } from '@inmolink/core';
import * as crm from '@inmolink/core/modules/crm';
import { countQueries, createFounder, type Founder } from '@inmolink/core/test';
import { closeDb } from '@inmolink/db';
import { adminQuery, setupTestDb, withAdminRollback } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * A member's ICS feed at 2,000 events (S11-F7): 1,000 upcoming and 1,000 of the last 30 days, each with a 300-character
 * description and a contact attendee — the feed keeps the 1,000 that matter (`FEED_MAX_EVENTS`, upcoming first). The full
 * answer (the SECURITY DEFINER read, the render, one gzip) stays in the feed-api budget; a matching If-None-Match is
 * answered from `calendar_feed_tag` alone. The rows are committed (inserted with FK checks off) and deleted afterwards.
 */

const EVENTS = 2_000;
const KEY = 'perf-calendar-feed-hmac-key-0123456789ab';
let founder: Founder;
let token = '';

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)] as number;
async function timed(runs: number, fn: () => Promise<unknown>): Promise<number[]> {
  for (let i = 0; i < 5; i += 1) await fn(); // warm (JIT)
  const ms: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    await fn();
    ms.push(performance.now() - t0);
  }
  return ms;
}

beforeAll(async () => {
  await setupTestDb('worker');
  crm.configureCalendarFeeds({ tokenKey: KEY });
  founder = await createFounder();
  const agency = founder.agencyId;
  const half = EVENTS / 2;
  // starts: g ≤ half upcoming (1 h … ~300 days ahead), the rest in the last ~29 days; updated_at with microseconds
  await adminQuery(`begin;
    set local session_replication_role = replica;
    insert into contacts (id, agency_id, first_name, last_name)
    select md5('${agency}' || g)::uuid, '${agency}', 'Client' || g, 'Perf' from generate_series(1, 50) g;
    insert into calendar_events (id, agency_id, type, title, description, location, starts_at, ends_at, status,
                                 cancelled_at, organizer_user_id, version, updated_at)
    select md5('${agency}' || 'e' || g)::uuid, '${agency}',
           (array['VIEWING', 'MEETING', 'CALL'])[1 + g % 3], 'Event ' || g || ', Calle Mayor ' || g,
           repeat('Notes about the client and the property, ' || g || '. ', 8), 'Marbella',
           s.starts, s.starts + interval '45 minutes', case when g % 50 = 0 then 'CANCELLED' else 'SCHEDULED' end,
           case when g % 50 = 0 then now() end, '${founder.userId}', 1 + g % 4, now() - (g * interval '1 second') - interval '0.000123 seconds'
      from generate_series(1, ${EVENTS}) g,
           lateral (select date_trunc('milliseconds', case when g <= ${half}
             then now() + interval '1 hour' + g * interval '7 hours'
             else now() - (g - ${half}) * interval '41 minutes' end) as starts) s;
    insert into calendar_event_attendees (id, agency_id, event_id, user_id, starts_at)
    select gen_random_uuid(), agency_id, id, organizer_user_id, starts_at from calendar_events where agency_id = '${agency}';
    insert into calendar_event_attendees (id, agency_id, event_id, contact_id, starts_at)
    select gen_random_uuid(), e.agency_id, e.id, md5('${agency}' || (1 + abs(hashtext(e.id::text)) % 50))::uuid,
           e.starts_at from calendar_events e where e.agency_id = '${agency}';
    commit;`);
  await adminQuery('vacuum analyze calendar_events');
  await adminQuery('vacuum analyze calendar_event_attendees');
  token = (
    await withMemberCtx(
      { userId: founder.userId, agencyId: founder.agencyId, requestId: newId(), locale: 'en' },
      (ctx) => crm.rotateCalendarFeed(ctx),
    )
  ).token;
}, 300_000);

afterAll(async () => {
  await adminQuery(`begin;
    set local session_replication_role = replica;
    delete from calendar_event_attendees where agency_id = '${founder.agencyId}';
    delete from calendar_events where agency_id = '${founder.agencyId}';
    delete from calendar_feeds where agency_id = '${founder.agencyId}';
    delete from contacts where agency_id = '${founder.agencyId}';
    commit;`);
  await closeDb();
}, 180_000);

describe('ICS feed at 2,000 events', () => {
  it('[S11-F7] a 1,000-event feed renders p95 < 150 ms (definer read, render, one gzip), under the size cap', async () => {
    const now = new Date();
    const file = await crm.calendarFeed(token, { now });
    expect(file.body.match(/BEGIN:VEVENT/g)).toHaveLength(1_000);
    expect(file.gzip.byteLength).toBeLessThanOrEqual(150 * 1024);
    expect(gunzipSync(file.gzip).toString('utf8')).toBe(file.body);
    // the 200's weak ETag is the fingerprint's (JS from the rows = SQL), microsecond update times included
    expect(await crm.calendarFeedTag(token, { now })).toBe(file.etag);
    expect(await countQueries(() => crm.calendarFeed(token))).toBe(1);
    const ms = await timed(20, () => crm.calendarFeed(token));
    console.info(`calendarFeed, 1,000 of 2,000 events: p95 ${p95(ms).toFixed(1)} ms, ${file.gzip.byteLength} B gzip`);
    expect(p95(ms)).toBeLessThan(150);
  }, 120_000);

  it('[S11-F7] the fingerprint for a 304 costs one statement, p95 < 20 ms at 2,000 events', async () => {
    expect(await countQueries(() => crm.calendarFeedTag(token))).toBe(1);
    const ms = await timed(30, () => crm.calendarFeedTag(token));
    // the statement on the server (EXPLAIN ANALYZE as the owner): what the 304 costs the database
    const hash = (
      await adminQuery<{ token_hash: string }>(
        `select token_hash from calendar_feeds where agency_id = $1 and revoked_at is null`,
        [founder.agencyId],
      )
    )[0]?.token_hash as string;
    const plan = await adminQuery('explain (analyze, buffers) select * from calendar_feed_tag($1)', [hash]);
    const server = plan.map((r) => String(Object.values(r)[0])).filter((l) => /Buffers|Execution/.test(l));
    console.info(`calendarFeedTag, 2,000 events: p95 ${p95(ms).toFixed(1)} ms; server ${server.join(', ')}`);
    expect(p95(ms)).toBeLessThan(20);
  }, 120_000);

  it('[S12-F22] a 304 at 2,000 events reads ≤ 10 buffers: the feed row and the login, nothing per event', async () => {
    const hash = (
      await adminQuery<{ token_hash: string }>(
        `select token_hash from calendar_feeds where agency_id = $1 and revoked_at is null`,
        [founder.agencyId],
      )
    )[0]?.token_hash as string;
    // the statement on the server (EXPLAIN ANALYZE as the owner) in a warm session, as feed-api's pooled connections
    // are: the first call of a session also reads the catalog to plan the function's body
    const out = await withAdminRollback([], async (q) => {
      await q('select * from calendar_feed_tag($1)', [hash]);
      return q<Record<string, unknown>>('explain (analyze, buffers, format json) select * from calendar_feed_tag($1)', [
        hash,
      ]);
    });
    const top = (Object.values(out[0] ?? {})[0] as { Plan: Record<string, unknown> }[])[0]?.Plan ?? {};
    const buffers = Number(top['Shared Hit Blocks'] ?? 0) + Number(top['Shared Read Blocks'] ?? 0);
    console.info(`calendarFeedTag at 2,000 events: ${buffers} buffers`);
    expect(buffers).toBeGreaterThan(0);
    expect(buffers).toBeLessThanOrEqual(10);
  }, 60_000);
});
