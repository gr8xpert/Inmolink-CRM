import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { closeDb, createOutboxDispatcher, withMemberCtx } from '@inmolink/core';
import * as chat from '@inmolink/core/modules/chat';
import { createFounder } from '@inmolink/core/test';
import { adminQuery, setupTestDb } from '@inmolink/db/testing';
import {
  cacheConnection,
  closeCache,
  configureCache,
  pubSubConnections,
  subscribeUserEvents,
  whenReady,
} from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import {
  createAccessTokenSigner,
  createAccessTokenVerifier,
  generateAccessKeyPair,
  parsePublicKeys,
  privateKeyFromBase64,
} from '@inmolink/platform/jwt';
import { createLogger } from '@inmolink/platform/logger';
import type { Dispatcher } from '@inmolink/platform/outbox';
import { closeQueues, configureQueue, type PoolHandle, registerPool } from '@inmolink/platform/queue';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type RealtimeApp } from './app';

/**
 * S11-03 acceptance, end to end: `chat.sendMessage` (a member's request transaction, commit) → outbox → the dispatcher
 * (250 ms poll, ADR 0014) → the `chat.deliverMessage` job (BullMQ, pool `realtime`) → `publishUserEvents` → two realtime
 * nodes (Redis adapter) → each recipient's socket. 1,000 members of one agency are connected (`CHAT_E2E_SOCKETS`), in
 * 100 threads of 10; latency = before the send call → receipt, per recipient (the sender's own socket not counted).
 * Everything runs in this process (one clock; the sockets' CPU counts against the servers: pessimistic). The dispatcher
 * claims every agency's due events like a worker would; events of other suites with no subscriber here are marked done.
 */

const SOCKETS = Number(process.env.CHAT_E2E_SOCKETS ?? 1_000);
const THREAD_SIZE = 10;
const MESSAGES = 100;
const RATE_PER_SECOND = 10;
const RUN = newId().slice(-8).toLowerCase();
const ORIGIN = 'http://localhost:3100';
const log = createLogger({ service: 'chat-e2e-test', level: 'silent' });
const pair = generateAccessKeyPair();
const signer = createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 'k1' });

let agencyId = '';
const users: string[] = [];
const threads: { id: string; members: string[] }[] = [];
const nodes: { realtime: RealtimeApp; url: string; close: () => Promise<void> }[] = [];
const sockets: Socket[] = [];
let dispatcher: Dispatcher;
let pool: PoolHandle;
/** Pending deliveries by message body: recipients still waiting, and when the send started. */
const pending = new Map<string, { started: number; waiting: Set<string> }>();
const latencies: number[] = [];

async function startNode() {
  const { pub, sub } = pubSubConnections();
  const events = pub.duplicate();
  const realtime = await buildApp({
    logger: log,
    trustProxy: false,
    checks: {},
    adapter: { pub, sub },
    verifier: createAccessTokenVerifier({ publicKeys: parsePublicKeys(`k1:${pair.publicKey}`) }),
    allowedOrigins: [ORIGIN],
    userEvents: (handler) => subscribeUserEvents(events, handler, log),
  });
  await realtime.app.listen({ host: '127.0.0.1', port: 0 });
  return {
    realtime,
    url: `http://127.0.0.1:${(realtime.app.server.address() as AddressInfo).port}`,
    close: async () => {
      await realtime.drain();
      await Promise.all([pub.quit(), sub.quit(), events.quit()]);
    },
  };
}

async function openSocket(url: string, userId: string): Promise<Socket | null> {
  const { token } = await signer.sign({ sub: userId, aud: 'realtime', sv: 1, agency: agencyId });
  return new Promise((resolve) => {
    const socket = connect(`${url}/chat`, {
      transports: ['websocket'],
      reconnection: false,
      auth: { token },
      extraHeaders: { origin: ORIGIN },
      timeout: 20_000,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', () => {
      socket.close();
      resolve(null);
    });
    socket.on('message', (data: { message: { body: string } }) => {
      const p = pending.get(data.message.body);
      if (!p?.waiting.delete(userId)) return;
      latencies.push(performance.now() - p.started);
      if (p.waiting.size === 0) pending.delete(data.message.body);
    });
  });
}

async function send(thread: { id: string; members: string[] }, body: string): Promise<void> {
  const [sender, ...recipients] = thread.members as [string, ...string[]];
  pending.set(body, { started: performance.now(), waiting: new Set(recipients) });
  await withMemberCtx({ userId: sender, agencyId, requestId: newId() }, (ctx) =>
    chat.sendMessage(ctx, thread.id, { body }),
  );
}

const until = async (done: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
};

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;
};

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ url: process.env.REDIS_CACHE_URL, logger: log, commandTimeoutMs: 2_000 });
  await whenReady(cacheConnection(), 10_000);
  await configureQueue({ prefix: `test-chat-e2e-${RUN}`, logger: log });

  agencyId = (await createFounder()).agencyId;
  // the agency's members (one socket each) and their DIRECT threads of 10, seeded as the superuser
  const members = await adminQuery<{ id: string }>(
    `with u as (
       insert into users (id, email, password_hash, name, locale, status)
       select gen_random_uuid(), 'chat-e2e-' || $2 || '-' || g || '@example.com', 'x', 'Member ' || g, 'en', 'ACTIVE'
         from generate_series(1, $1::int) g
       returning id, email, name)
     insert into agency_members (agency_id, user_id, role, name, email)
     select $3::uuid, id, 'AGENT', name, email from u returning user_id as id`,
    [SOCKETS, RUN, agencyId],
  );
  users.push(...members.map((m) => m.id));
  for (let i = 0; i + THREAD_SIZE <= users.length; i += THREAD_SIZE) {
    threads.push({ id: newId(), members: users.slice(i, i + THREAD_SIZE) });
  }
  await adminQuery(
    `insert into chat_threads (agency_id, id, kind, created_by_user_id)
     select $1::uuid, t, 'DIRECT', null from unnest($2::uuid[]) t`,
    [agencyId, threads.map((t) => t.id)],
  );
  await adminQuery(
    `insert into chat_participants (agency_id, thread_id, user_id)
     select $1::uuid, (x ->> 't')::uuid, (x ->> 'u')::uuid from jsonb_array_elements($2::jsonb) x`,
    [agencyId, JSON.stringify(threads.flatMap((t) => t.members.map((u) => ({ t: t.id, u }))))],
  );

  // the worker side: the chat subscriptions, the outbox dispatcher and the delivery job's pool
  chat.registerChatSubscriptions();
  pool = registerPool('realtime', [chat.chatJobs.deliverMessage], { concurrency: 16 });
  dispatcher = createOutboxDispatcher({ logger: log });
  await dispatcher.start();

  nodes.push(await startNode(), await startNode());
  for (let i = 0; i < users.length; i += 50) {
    const opened = await Promise.all(
      users
        .slice(i, i + 50)
        .map((u, j) => openSocket((nodes[(i + j) % nodes.length] as (typeof nodes)[number]).url, u)),
    );
    for (const s of opened) if (s) sockets.push(s);
  }
  // warm-up: the first delivery waits for the dispatcher to work through other suites' due events
  await send(threads[0] as (typeof threads)[number], `warm-${RUN}`);
  await until(() => pending.size === 0, 120_000);
  latencies.length = 0;
}, 300_000);

afterAll(async () => {
  for (const s of sockets) s.close();
  for (const n of nodes) await n.close();
  await dispatcher?.stop();
  await pool?.close();
  chat.unregisterChatSubscriptions();
  if (agencyId) {
    await adminQuery(`delete from chat_messages where agency_id = $1`, [agencyId]);
    await adminQuery(`delete from chat_participants where agency_id = $1`, [agencyId]);
    await adminQuery(`delete from chat_threads where agency_id = $1`, [agencyId]);
  }
  await closeQueues();
  await closeCache();
  await closeDb();
}, 120_000);

describe('chat fan-out end to end', () => {
  it('[S11-03] message fan-out p95 < 500 ms with 1,000 connected sockets: send → commit → outbox → job → sockets', async () => {
    const started = performance.now();
    for (let m = 0; m < MESSAGES; m++) {
      await send(threads[m % threads.length] as (typeof threads)[number], `e2e-${RUN}-${m}`);
      const wait = started + ((m + 1) * 1_000) / RATE_PER_SECOND - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    await until(() => pending.size === 0, 60_000);
    const expected = MESSAGES * (THREAD_SIZE - 1);
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const max = Math.max(...latencies);
    console.info(
      `[S11-03] chat end to end: ${sockets.length}/${SOCKETS} sockets on 2 nodes, ${latencies.length}/${expected} ` +
        `deliveries, p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${max.toFixed(1)} ms`,
    );
    expect(sockets.length).toBe(SOCKETS);
    expect(latencies.length).toBe(expected);
    expect(p95).toBeLessThan(500);
  });
});
