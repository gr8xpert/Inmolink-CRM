import { closeDb, countQueries } from '@inmolink/db';
import { adminQuery, loadStackEnv, setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import { registeredClientCipher } from '../config';
import * as mls from '../index';

/**
 * My collaborations (S11-06): one agency with 500 collaborations — 125 each of its own registrations, registrations
 * received for its targets, viewing requests it made and viewing requests it received — read through the four mls
 * lists the dashboard view loads, with the view's filters (state, kind, date range). Rows are seeded with triggers off
 * (replica role, both copies explicitly) and deleted afterwards.
 */

const RUN = newId().slice(-8).toLowerCase();
const N = 125;
const keyring = createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' });

/** `a` is the agency whose view loads; `b` is its counterpart in all 500 collaborations. */
let a: Founder;
let b: Founder;

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

const lit = (v: string | null) => (v === null ? 'null' : `'${v}'`);

/** Every 5th row targets a development; every 2nd registration is expired; registered one day apart, newest first. */
function registrationsSql(introducer: string, owner: string): string {
  const own: string[] = [];
  const receipts: string[] = [];
  for (let i = 1; i <= N; i++) {
    const id = newId();
    const kind = i % 5 === 0 ? 'DEVELOPMENT' : 'LISTING';
    const target = newId();
    const registered = `now() - interval '${i} days'`;
    const expires = i % 2 === 0 ? `now() - interval '1 day'` : `now() + interval '100 days'`;
    const enc = registeredClientCipher.encrypt(introducer, id, {
      firstName: `Client${i}`,
      lastName: 'Test',
      emails: [`c${i}@example.test`],
      phones: [],
    });
    own.push(
      `(${lit(id)}, ${lit(introducer)}, ${lit(owner)}, '${kind}', ${lit(target)}, ${lit(newId())}, ${lit(enc)}, ${registered}, ${expires})`,
    );
    receipts.push(
      `(${lit(id)}, ${lit(owner)}, ${lit(introducer)}, '${kind}', ${lit(target)}, ${registered}, ${expires})`,
    );
  }
  return `
    insert into client_registrations (id, agency_id, target_agency_id, target_kind, target_id, contact_id, details_enc, registered_at, expires_at)
      values ${own.join(',')};
    insert into client_registration_receipts (registration_id, agency_id, introducer_agency_id, target_kind, target_id, registered_at, expires_at)
      values ${receipts.join(',')};`;
}

/** Requested (odd) and declined (even) proposals, every 5th for a development, created one day apart. */
const viewingsSql = (introducer: string, owner: string) => `
  insert into viewing_requests (id, agency_id, owner_agency_id, registration_id, contact_id, target_kind, target_id,
                                status, awaiting, closed_by, proposed_start_at, expires_at, commission_bp, split_bp,
                                commission_includes_vat, terms_valid_until, created_at, updated_at)
  select gen_random_uuid(), '${introducer}', '${owner}', gen_random_uuid(), gen_random_uuid(),
         case when g % 5 = 0 then 'DEVELOPMENT' else 'LISTING' end, gen_random_uuid(),
         case when g % 2 = 0 then 'DECLINED' else 'REQUESTED' end,
         case when g % 2 = 0 then null else 'OWNER' end,
         case when g % 2 = 0 then 'OWNER' else null end,
         now() + interval '5 days', now() + interval '2 days', 500, 5000, false,
         now() + interval '90 days', now() - g * interval '1 day', now()
    from generate_series(1, ${N}) g;
  insert into viewing_request_receipts (request_id, agency_id, introducer_agency_id, target_kind, target_id, status,
                                        awaiting, closed_by, proposed_start_at, expires_at, commission_bp, split_bp,
                                        commission_includes_vat, terms_valid_until, terms_at, introducer_accepted_at,
                                        created_at, updated_at)
  select id, owner_agency_id, agency_id, target_kind, target_id, status, awaiting, closed_by, proposed_start_at,
         expires_at, commission_bp, split_bp, commission_includes_vat, terms_valid_until, terms_at,
         introducer_accepted_at, created_at, updated_at
    from viewing_requests where agency_id = '${introducer}' and owner_agency_id = '${owner}';`;

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  mls.configureMls({ keyring, fingerprintKey: `test-fingerprint-key-${RUN}-0123456789abcdef` });
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  await adminQuery(`begin;
    set local session_replication_role = replica;
    ${registrationsSql(a.agencyId, b.agencyId)}
    ${registrationsSql(b.agencyId, a.agencyId)}
    ${viewingsSql(a.agencyId, b.agencyId)}
    ${viewingsSql(b.agencyId, a.agencyId)}
    commit;`);
}, 120_000);

afterAll(async () => {
  for (const m of [a, b]) {
    await adminQuery(`begin; set local session_replication_role = replica;
      delete from viewing_request_receipts where introducer_agency_id = '${m.agencyId}' or agency_id = '${m.agencyId}';
      delete from viewing_requests where agency_id = '${m.agencyId}';
      delete from client_registration_receipts where introducer_agency_id = '${m.agencyId}' or agency_id = '${m.agencyId}';
      delete from client_registrations where agency_id = '${m.agencyId}'; commit;`);
  }
  await closeDb();
}, 60_000);

/** What the dashboard view loads for the agency with no filter: the first rows of each of the four lists. */
const loadView = (m: Founder, limit = 10) =>
  as(m, async (ctx) => ({
    own: await mls.listRegistrations(ctx, { limit }),
    received: await mls.listReceivedRegistrations(ctx, { limit }),
    viewings: await mls.listViewingRequests(ctx, { limit }),
    receivedViewings: await mls.listReceivedViewingRequests(ctx, { limit }),
  }));

describe('my collaborations view', () => {
  it('[S11-06] loads within 10 queries for an agency with 500 collaborations', async () => {
    const setup = await countQueries(() => as(a, async () => null));
    let view: Awaited<ReturnType<typeof loadView>> | undefined;
    const total = await countQueries(async () => {
      view = await loadView(a);
    });
    expect(total - setup).toBeLessThanOrEqual(10);
    expect(view?.own.items).toHaveLength(10);
    expect(view?.received.items).toHaveLength(10);
    expect(view?.viewings.items).toHaveLength(10);
    expect(view?.receivedViewings.items).toHaveLength(10);
    // newest first, with a cursor to the rest
    expect(view?.own.nextCursor).not.toBeNull();
    // the owner's side never carries the client
    expect(JSON.stringify(view?.received)).not.toContain('Client');
  });

  it('[S11-06] filters registrations by state, kind and date', async () => {
    const all = (q: Parameters<typeof mls.listRegistrations>[1]) => as(a, (ctx) => mls.listRegistrations(ctx, q));
    const active = await all({ limit: 100, state: 'ACTIVE' });
    const expired = await all({ limit: 100, state: 'EXPIRED' });
    expect(active.items).toHaveLength(63);
    expect(expired.items).toHaveLength(62);
    expect(active.items.every((r) => new Date(r.expiresAt) > new Date())).toBe(true);
    const developments = await all({ limit: 100, kind: 'DEVELOPMENT' });
    expect(developments.items).toHaveLength(25);
    expect(developments.items.every((r) => r.target.kind === 'DEVELOPMENT')).toBe(true);
    // registered 1..10 days ago: the last 10 days (UTC days, so one boundary day of slack)
    const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
    const recent = await all({ limit: 100, from: day(10) });
    expect(recent.items.length).toBeGreaterThanOrEqual(9);
    expect(recent.items.length).toBeLessThanOrEqual(11);
    const old = await all({ limit: 100, to: day(120) });
    expect(old.items.length).toBeLessThanOrEqual(6);
    expect(old.items.length).toBeGreaterThanOrEqual(4);
    // the received list takes the same filters
    const receivedExpired = await as(a, (ctx) => mls.listReceivedRegistrations(ctx, { limit: 100, state: 'EXPIRED' }));
    expect(receivedExpired.items).toHaveLength(62);
  });

  it('[S11-06] the day range edges are midnights in the agency time zone', async () => {
    // one registration at 2026-03-10 23:30 UTC = 2026-03-11 00:30 in Madrid (UTC+1 before the March change)
    const zoned = await createFounder();
    await adminQuery(`update agency_settings set time_zone = 'Europe/Madrid' where agency_id = '${zoned.agencyId}'`);
    const id = newId();
    const enc = registeredClientCipher.encrypt(zoned.agencyId, id, {
      firstName: 'Z',
      lastName: 'Z',
      emails: [],
      phones: [],
    });
    await adminQuery(`begin; set local session_replication_role = replica;
      insert into client_registrations (id, agency_id, target_agency_id, target_kind, target_id, contact_id, details_enc, registered_at, expires_at)
        values ('${id}', '${zoned.agencyId}', '${b.agencyId}', 'LISTING', '${newId()}', '${newId()}', '${enc}', '2026-03-10T23:30:00Z', now() + interval '10 days');
      commit;`);
    try {
      const day = (q: { from?: string; to?: string }) =>
        as(zoned, (ctx) => mls.listRegistrations(ctx, { limit: 10, ...q })).then((r) => r.items.length);
      expect(await day({ from: '2026-03-11', to: '2026-03-11' })).toBe(1);
      expect(await day({ from: '2026-03-10', to: '2026-03-10' })).toBe(0);
      expect(await day({ to: '2026-03-10' })).toBe(0);
    } finally {
      await adminQuery(
        `begin; set local session_replication_role = replica; delete from client_registrations where id = '${id}'; commit;`,
      );
    }
  });

  it('[S11-06] a listed registration carries its state from the database clock', async () => {
    const page = await as(a, (ctx) => mls.listRegistrations(ctx, { limit: 4 }));
    for (const r of page.items) expect(r.state).toBe(new Date(r.expiresAt) > new Date() ? 'ACTIVE' : 'EXPIRED');
    const received = await as(a, (ctx) => mls.listReceivedRegistrations(ctx, { limit: 4 }));
    expect(new Set(received.items.map((r) => r.state)).size).toBeGreaterThan(0);
  });

  it('[S11-06] filters viewing requests by state and kind, in and out', async () => {
    const out = await as(a, (ctx) => mls.listViewingRequests(ctx, { limit: 100, status: 'DECLINED' }));
    const incoming = await as(a, (ctx) => mls.listReceivedViewingRequests(ctx, { limit: 100, status: 'REQUESTED' }));
    expect(out.items).toHaveLength(62);
    expect(out.items.every((v) => v.status === 'DECLINED' && v.side === 'INTRODUCER')).toBe(true);
    expect(incoming.items).toHaveLength(63);
    expect(incoming.items.every((v) => v.status === 'REQUESTED' && v.side === 'OWNER')).toBe(true);
    const developments = await as(a, (ctx) =>
      mls.listViewingRequests(ctx, { limit: 100, kind: 'DEVELOPMENT', status: 'REQUESTED' }),
    );
    expect(developments.items.every((v) => v.target.kind === 'DEVELOPMENT' && v.status === 'REQUESTED')).toBe(true);
    expect(developments.items).toHaveLength(13);
  });

  it('[S11-06] a filtered list pages by keyset across the filter', async () => {
    const first = await as(a, (ctx) => mls.listRegistrations(ctx, { limit: 30, state: 'ACTIVE' }));
    expect(first.nextCursor).not.toBeNull();
    const second = await as(a, (ctx) =>
      mls.listRegistrations(ctx, {
        limit: 30,
        state: 'ACTIVE',
        ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
      }),
    );
    expect(second.items).toHaveLength(30);
    const seen = new Set([...first.items, ...second.items].map((r) => r.id));
    expect(seen.size).toBe(60);
  });
});
