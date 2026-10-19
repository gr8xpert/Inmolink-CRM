import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CreateFeedConnectionBody, type FeedConnectionDto } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { allowLoopbackOriginsForTests } from '@inmolink/platform/safe-fetch';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as imports from '../index';
import { gate, gatedConnector, testXmlConnector } from './test-connectors';

/** Feed connections, runs, the per-connection mutex and the run pipeline on the real database (S6-01). */

const log = createLogger({ service: 'imports-test', level: 'silent' });
let owner: Founder;
let stranger: Founder;
let server: Server;
let origin: string;
let undoLoopback: () => void;
const undo: (() => void)[] = [];
const requests: { path: string; authorization?: string }[] = [];
const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void>();

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (err: { code?: string }) => err.code ?? String(err),
  );
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('imports.runs.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
type JobOver = Partial<{ lastAttempt: boolean; noWait: boolean }>;
/** `noWait`: the job's signal is already aborted, so a run held by a live lease is skipped without waiting it out. */
const job = (over: JobOver = {}) => ({
  log,
  signal: over.noWait ? AbortSignal.abort() : new AbortController().signal,
  lastAttempt: over.lastAttempt ?? true,
});

const xml = (items: string) => `<?xml version="1.0" encoding="UTF-8"?><feed>${items}</feed>`;
const item = (ref: string, price: string) => `<property><ref>${ref}</ref><price>${price}</price></property>`;

function feed(path: string, body: string, contentType = 'application/xml') {
  routes.set(path, (_req, res) => res.writeHead(200, { 'content-type': contentType }).end(body));
}

async function connection(over: Partial<CreateFeedConnectionBody> = {}, m: Founder = owner) {
  return as(m, (ctx) =>
    imports.createFeedConnection(
      ctx,
      CreateFeedConnectionBody.parse({
        name: 'Kyero feed',
        connector: 'test-xml',
        url: `${origin}/feed.xml`,
        scheduleMinutes: null,
        ...over,
      }),
    ),
  );
}

const runNow = (c: Pick<FeedConnectionDto, 'id'>, m: Founder = owner) =>
  as(m, (ctx) => imports.requestFeedRun(ctx, c.id));
const execute = (runId: string, m: Founder = owner, over: JobOver = {}) =>
  // The run machinery (S6-01) with the count-only sink; the listing loader has its own suite (loader.int.test.ts).
  imports.executeRun({ runId, agencyId: m.agencyId }, job(over), imports.countOnlySink);
const runRow = async (runId: string) =>
  (
    await rows<{
      state: string;
      error_code: string | null;
      items_total: number;
      items_valid: number;
      items_failed: number;
      lease_token: string | null;
      attempt: number;
    }>(
      sql`select state, error_code, items_total, items_valid, items_failed, lease_token, attempt
          from feed_runs where id = ${runId}`,
    )
  )[0];

beforeAll(async () => {
  await setupTestDb('worker');
  imports.configureImports({ keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }) });
  [owner, stranger] = await Promise.all([createFounder(), createFounder()]);
  server = createServer((req, res) => {
    requests.push({ path: req.url ?? '', authorization: req.headers.authorization });
    const handler = routes.get(req.url ?? '');
    if (handler) handler(req, res);
    else res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  undoLoopback = allowLoopbackOriginsForTests([origin]);
  undo.push(imports.registerConnector(testXmlConnector));
}, 120_000);

afterAll(async () => {
  for (const u of undo) u();
  undoLoopback();
  server.close();
  await closeDb();
});

describe('feed connections', () => {
  it('[S6-01] credentials are stored encrypted, sent to the feed, and never returned', async () => {
    feed('/auth.xml', xml(item('A1', '250000')));
    const c = await connection({
      url: `${origin}/auth.xml`,
      credentials: { type: 'basic', username: 'agency', password: 's3cret-feed-pass' },
    });
    expect(c.hasCredentials).toBe(true);
    expect(JSON.stringify(c)).not.toContain('s3cret');
    const [stored] = await rows<{ credentials_enc: string }>(
      sql`select credentials_enc from feed_connections where id = ${c.id}`,
    );
    expect(stored?.credentials_enc).toMatch(/^v1\.k1\./);
    expect(stored?.credentials_enc).not.toContain('s3cret');
    const run = await runNow(c);
    expect(await execute(run.id)).toMatchObject({ kind: 'finished', state: 'SUCCEEDED' });
    const sent = requests.filter((r) => r.path === '/auth.xml').at(-1);
    expect(sent?.authorization).toBe(`Basic ${Buffer.from('agency:s3cret-feed-pass').toString('base64')}`);
  });

  it('[S6-01] moving a connection to another origin drops its credentials; agents see query values masked', async () => {
    const c = await connection({
      url: 'https://feeds.example.com/kyero.xml?apikey=SECRET123',
      credentials: { type: 'header', name: 'X-Api-Key', value: 'k-123' },
    });
    expect(c.url).toContain('SECRET123'); // the admin who manages it sees it
    const sameOrigin = await as(owner, (ctx) =>
      imports.updateFeedConnection(ctx, c.id, { version: c.version, url: 'https://feeds.example.com/v2.xml' }),
    );
    expect(sameOrigin.hasCredentials).toBe(true);
    const moved = await as(owner, (ctx) =>
      imports.updateFeedConnection(ctx, c.id, {
        version: sameOrigin.version,
        url: 'https://other.example.org/x.xml?k=1',
      }),
    );
    expect(moved.hasCredentials).toBe(false);
    const agentId = newId();
    await system(async (tx) => {
      await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
        values (${agentId}, ${`imp-agent-${agentId}@example.com`}, 'x', 'Agent', 'es', 'ACTIVE')`);
      await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
        values (${owner.agencyId}, ${agentId}, 'AGENT', 'Agent', ${`imp-agent-${agentId}@example.com`})`);
    });
    const agent = { ...owner, userId: agentId };
    const seen = await as(agent, (ctx) => imports.getFeedConnection(ctx, c.id));
    expect(seen.url).toBe('https://other.example.org/x.xml?k=***');
    expect(await refusal(as(agent, (ctx) => imports.deleteFeedConnection(ctx, c.id)))).toBe('FORBIDDEN');
  });

  it('[S6-03] credentials are refused on a plain-http feed; moving a feed to http drops them', async () => {
    const creds = { type: 'basic' as const, username: 'agency', password: 'pw-123456' };
    expect(await refusal(connection({ url: 'http://feeds.example.com/kyero.xml', credentials: creds }))).toBe(
      'FEED_URL_NOT_ALLOWED',
    );
    const c = await connection({ url: 'https://feeds.example.com/kyero.xml', credentials: creds });
    // sending credentials along with a move to http is refused; a move alone drops them (another origin)
    expect(
      await refusal(
        as(owner, (ctx) =>
          imports.updateFeedConnection(ctx, c.id, {
            version: c.version,
            url: 'http://feeds.example.com/kyero.xml',
            credentials: creds,
          }),
        ),
      ),
    ).toBe('FEED_URL_NOT_ALLOWED');
    const moved = await as(owner, (ctx) =>
      imports.updateFeedConnection(ctx, c.id, { version: c.version, url: 'http://feeds.example.com/kyero.xml' }),
    );
    expect(moved.hasCredentials).toBe(false);
    // without credentials a plain-http feed is fine (many agency feeds are http)
    const open = await connection({ url: 'http://feeds.example.com/open.xml' });
    expect(open.hasCredentials).toBe(false);
  });

  it('[S6-01] feed URLs naming private, loopback or metadata hosts are refused when saved', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/feed.xml',
      'http://[::1]/feed.xml',
      'http://localhost/feed.xml',
      'http://metadata.google.internal/',
      'https://user:pw@feeds.example.com/x.xml',
    ]) {
      expect(await refusal(connection({ url })), url).toBe('FEED_URL_NOT_ALLOWED');
    }
    expect(
      CreateFeedConnectionBody.safeParse({ name: 'x', connector: 'test-xml', url: 'file:///etc/passwd' }).success,
    ).toBe(false);
    expect(await refusal(connection({ connector: 'no-such-connector' }))).toBe('FEED_CONNECTOR_UNKNOWN');
  });

  it('[S6-01] another agency neither sees nor runs a connection; agents cannot change it', async () => {
    const c = await connection();
    expect(await refusal(as(stranger, (ctx) => imports.getFeedConnection(ctx, c.id)))).toBe(
      'FEED_CONNECTION_NOT_FOUND',
    );
    expect(await refusal(runNow(c, stranger))).toBe('FEED_CONNECTION_NOT_FOUND');
    const list = await as(stranger, (ctx) => imports.listFeedConnections(ctx, { limit: 100 }));
    expect(list.items.map((x) => x.id)).not.toContain(c.id);
  });
});

describe('feed runs', () => {
  it('[S6-01] a run streams the feed, counts valid and failed items and keeps the per-item errors', async () => {
    feed(
      '/mixed.xml',
      xml([item('A1', '250000'), item('A2', 'abc'), '<property><price>1</price></property>', item('A1', '3')].join('')),
    );
    const c = await connection({ url: `${origin}/mixed.xml` });
    const run = await runNow(c);
    expect(run.state).toBe('QUEUED');
    const [event] = await rows<{ type: string }>(
      sql`select type from outbox_events where payload->>'runId' = ${run.id} order by id`,
    );
    expect(event?.type).toBe('imports.run.requested');
    expect(await execute(run.id)).toEqual({ kind: 'finished', state: 'SUCCEEDED', errorCode: null });
    const done = await as(owner, (ctx) => imports.getFeedRun(ctx, run.id));
    expect(done).toMatchObject({ state: 'SUCCEEDED', counts: { total: 4, valid: 1, failed: 3 }, errorsLogged: 3 });
    expect(done.bytesRead).toBeGreaterThan(0);
    const errors = await as(owner, (ctx) => imports.listFeedItemErrors(ctx, run.id, { limit: 2 }));
    expect(errors.items.map((e) => [e.position, e.code, e.itemRef])).toEqual([
      [1, 'INVALID_PRICE', 'A2'],
      [2, 'MISSING_FIELD', null],
    ]);
    const rest = await as(owner, (ctx) =>
      imports.listFeedItemErrors(ctx, run.id, { limit: 2, cursor: errors.nextCursor ?? undefined }),
    );
    expect(rest.items.map((e) => e.code)).toEqual(['DUPLICATE_REF']);
    const history = await as(owner, (ctx) => imports.listFeedRuns(ctx, c.id, { limit: 10 }));
    expect(history.items.map((r) => r.id)).toEqual([run.id]);
    const after = await as(owner, (ctx) => imports.getFeedConnection(ctx, c.id));
    expect(after.lastRunState).toBe('SUCCEEDED');
    expect(
      await rows(
        sql`select 1 from outbox_events where type = 'imports.run.finished' and payload->>'runId' = ${run.id}`,
      ),
    ).toHaveLength(1);
  });

  it('[S6-01] a feed that redirects to a private or metadata address fails the run (SSRF refused after redirects)', async () => {
    routes.set('/redirect.xml', (_req, res) =>
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/iam/' }).end(),
    );
    const c = await connection({ url: `${origin}/redirect.xml` });
    const run = await runNow(c);
    expect(await execute(run.id, owner, { lastAttempt: false })).toEqual({
      kind: 'finished',
      state: 'FAILED',
      errorCode: 'FEED_DESTINATION_BLOCKED',
    });
    expect(await runRow(run.id)).toMatchObject({ state: 'FAILED', items_total: 0, lease_token: null });
  });

  it('[S6-01] a stored URL that now names a blocked address fails the run without a request', async () => {
    const c = await connection();
    await system((tx) =>
      tx.execute(sql`update feed_connections set url = 'http://10.1.2.3/feed.xml' where id = ${c.id}`),
    );
    const run = await runNow(c);
    expect(await execute(run.id)).toMatchObject({ state: 'FAILED', errorCode: 'FEED_DESTINATION_BLOCKED' });
  });

  it('[S6-01] XML with a DOCTYPE or entity declaration fails the run; nothing of it is loaded', async () => {
    feed(
      '/xxe.xml',
      `<?xml version="1.0"?><!DOCTYPE feed [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><feed>${item('X1', '1')}<property><ref>&xxe;</ref><price>1</price></property></feed>`,
    );
    const c = await connection({ url: `${origin}/xxe.xml` });
    const run = await runNow(c);
    expect(await execute(run.id)).toMatchObject({ state: 'FAILED', errorCode: 'FEED_DTD_NOT_ALLOWED' });
    expect(await runRow(run.id)).toMatchObject({ items_total: 0, items_valid: 0 });
  });

  it('[S6-01] a retryable failure re-queues the run for the next attempt; the last attempt fails it', async () => {
    routes.set('/flaky.xml', (_req, res) => res.writeHead(503).end());
    const c = await connection({ url: `${origin}/flaky.xml` });
    const run = await runNow(c);
    await expect(execute(run.id, owner, { lastAttempt: false })).rejects.toThrow(/HTTP 503/);
    expect(await runRow(run.id)).toMatchObject({ state: 'QUEUED', lease_token: null, attempt: 1 });
    expect(await refusal(runNow(c))).toBe('FEED_RUN_ACTIVE');
    expect(await execute(run.id, owner, { lastAttempt: true })).toMatchObject({
      state: 'FAILED',
      errorCode: 'FEED_HTTP_STATUS',
    });
    expect(await runRow(run.id)).toMatchObject({ attempt: 2 });
  });
});

describe('per-connection mutex', () => {
  it('[S6-01] two runs of the same connection never overlap: a second request is refused while one is active', async () => {
    feed('/one.xml', xml(item('B1', '100')));
    const c = await connection({ url: `${origin}/one.xml` });
    const results = await Promise.all(Array.from({ length: 6 }, () => refusal(runNow(c))));
    expect(results.filter((r) => r === 'resolved')).toHaveLength(1);
    expect(results.filter((r) => r === 'FEED_RUN_ACTIVE')).toHaveLength(5);
    const [active] = await rows<{ id: string }>(
      sql`select id from feed_runs where connection_id = ${c.id} and state in ('QUEUED', 'RUNNING')`,
    );
    // Two deliveries of the same job: one claims and runs, the other finds the run taken.
    const outcomes = await Promise.all([
      execute(active?.id as string, owner, { noWait: true }),
      execute(active?.id as string, owner, { noWait: true }),
    ]);
    expect(outcomes.map((o) => o.kind).sort()).toEqual(['finished', 'skipped']);
    // Once it ended, the next run may start.
    expect((await runNow(c)).state).toBe('QUEUED');
  });

  it('[S6-01] two runs of the same connection never overlap: a stalled worker that lost its lease writes nothing more', async () => {
    const key = `test-gated-${newId().slice(-6)}`;
    const stalled = gate();
    undo.push(imports.registerConnector(gatedConnector(key, 600, stalled)));
    const c = await connection({ connector: key });
    const run = await runNow(c);
    const workerA = execute(run.id);
    await stalled.reached; // A committed its first batch and is parked mid-feed, lease held
    expect(await runRow(run.id)).toMatchObject({ state: 'RUNNING', items_total: 500 });
    // While A's lease is live, nobody else can claim the run.
    expect(await execute(run.id, owner, { noWait: true })).toEqual({ kind: 'skipped' });
    // A stalls past its lease; B (the job's retry) reclaims the run and completes it.
    await system((tx) =>
      tx.execute(sql`update feed_runs set lease_until = now() - interval '1 minute' where id = ${run.id}`),
    );
    const free = gate();
    free.open();
    undo.push(imports.registerConnector(gatedConnector(key, 600, free)));
    expect(await execute(run.id)).toMatchObject({ kind: 'finished', state: 'SUCCEEDED' });
    // A wakes up: its next batch finds another token on the run and stops without writing.
    stalled.open();
    expect(await workerA).toEqual({ kind: 'lost' });
    expect(await runRow(run.id)).toMatchObject({ state: 'SUCCEEDED', items_total: 600, attempt: 2 });
  });

  it('[S6-01] the run of a crashed worker is taken over once its lease lapses, never before', async () => {
    feed('/takeover.xml', xml(item('T1', '100')));
    const c = await connection({ url: `${origin}/takeover.xml` });
    const run = await runNow(c);
    // A worker claimed the run and died: its lease runs ~1.5 s more and nobody renews it.
    await system((tx) =>
      tx.execute(sql`update feed_runs set state = 'RUNNING', attempt = 1, lease_token = ${newId()},
                     lease_until = now() + interval '1500 milliseconds' where id = ${run.id}`),
    );
    const started = Date.now();
    expect(await execute(run.id)).toMatchObject({ kind: 'finished', state: 'SUCCEEDED' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
    expect(await runRow(run.id)).toMatchObject({ state: 'SUCCEEDED', attempt: 2, items_total: 1 });
  });

  it('[S6-01] the scheduler queues due connections once, skips a slot while a run is active, and frees dead runs', async () => {
    feed('/sched.xml', xml(item('S1', '100')));
    const c = await connection({ url: `${origin}/sched.xml`, scheduleMinutes: 60 });
    const schedule = () =>
      imports.importsJobs.scheduleFeeds.spec.run(
        {},
        { log, jobId: newId(), attempt: 1, progress: async () => {}, signal: new AbortController().signal },
      );
    const runsOf = () =>
      rows<{ id: string; state: string; trigger: string }>(
        sql`select id, state, trigger from feed_runs where connection_id = ${c.id} order by created_at`,
      );
    await schedule();
    const first = await runsOf();
    expect(first).toEqual([expect.objectContaining({ state: 'QUEUED', trigger: 'SCHEDULE' })]);
    const [next] = await rows<{ next_run_at: string }>(
      sql`select next_run_at from feed_connections where id = ${c.id}`,
    );
    expect(new Date(String(next?.next_run_at)).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    // Due again while the first run is still queued: the slot is skipped, never a second active run.
    await system((tx) => tx.execute(sql`update feed_connections set next_run_at = now() where id = ${c.id}`));
    await schedule();
    expect(await runsOf()).toHaveLength(1);
    // The run's worker dies mid-run: after the grace period the scheduler fails it and frees the slot.
    await system((tx) =>
      tx.execute(sql`update feed_runs set state = 'RUNNING', lease_token = ${newId()},
                     lease_until = now() - interval '1 hour' where id = ${first[0]?.id}`),
    );
    await system((tx) => tx.execute(sql`update feed_connections set next_run_at = now() where id = ${c.id}`));
    await schedule();
    const after = await runsOf();
    expect(after.map((r) => r.state)).toEqual(['FAILED', 'QUEUED']);
    expect((await runRow(first[0]?.id as string))?.error_code).toBe('FEED_LEASE_EXPIRED');
  });

  it('[S6-01] a disabled connection cannot be run', async () => {
    const c = await connection({ enabled: false });
    expect(await refusal(runNow(c))).toBe('FEED_CONNECTION_DISABLED');
  });
});
