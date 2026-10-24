import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { loadStackEnv } from '@inmolink/core';
import {
  cacheConnection,
  closeCache,
  configureCache,
  publishUserEvents,
  pubSubConnections,
  subscribeUserEvents,
  type UserEvent,
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
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type RealtimeApp } from './app';

/**
 * S11-03 load test: chat message fan-out with many connected sockets, on the production path — two realtime nodes
 * with the Redis adapter, every message published per participant by `publishUserEvents` (one pipeline, what the
 * `chat.deliverMessage` job does), received by each participant's own socket. Latency = publish start → receipt, per
 * delivery (one clock: everything runs in this process, so the sockets' CPU counts against the servers — a pessimistic
 * measure). `CHAT_FANOUT_SOCKETS` sets the scale (default 1,000); threads of 10 participants, plus bursts to a
 * 100-participant thread (both agencies' maximum).
 */

const SOCKETS = Number(process.env.CHAT_FANOUT_SOCKETS ?? 1_000);
const THREAD_SIZE = 10;
const MESSAGES = 300;
const RATE_PER_SECOND = 30;
const BIG_THREAD = 100;
const BIG_MESSAGES = 20;
const ORIGIN = 'http://localhost:3100';
const AGENCY = newId();
const log = createLogger({ service: 'chat-fanout-test', level: 'silent' });
const pair = generateAccessKeyPair();
const signer = createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 'k1' });

interface Node {
  realtime: RealtimeApp;
  url: string;
  close: () => Promise<void>;
}
const nodes: Node[] = [];
const sockets: Socket[] = [];
const users: string[] = [];
/** Pending deliveries: message id → recipients still waiting, and the publish start. */
const pending = new Map<string, { started: number; waiting: Set<string> }>();
const latencies: number[] = [];

async function startNode(): Promise<Node> {
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
  const { token } = await signer.sign({ sub: userId, aud: 'realtime', sv: 1, agency: AGENCY });
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
    socket.on('message', (data: { message: { id: string } }) => {
      const p = pending.get(data.message.id);
      if (!p?.waiting.delete(userId)) return;
      latencies.push(performance.now() - p.started);
      if (p.waiting.size === 0) pending.delete(data.message.id);
    });
  });
}

/** One message to `recipients`: one `UserEvent` each, in one pipeline. */
async function send(threadId: string, recipients: readonly string[]): Promise<void> {
  const id = newId();
  pending.set(id, { started: performance.now(), waiting: new Set(recipients) });
  const message = {
    id,
    threadId,
    sender: { agencyId: AGENCY, userId: recipients[0] as string, name: 'Load', ownAgency: true },
    body: 'x'.repeat(200),
    createdAt: new Date().toISOString(),
  };
  const events: UserEvent[] = recipients.map((userId) => ({
    userId,
    agencyId: AGENCY,
    namespace: '/chat',
    event: 'message',
    data: { agencyId: AGENCY, message },
  }));
  await publishUserEvents(events);
}

const until = async (done: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
};

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;
};

beforeAll(async () => {
  loadStackEnv('test');
  await configureCache({ url: process.env.REDIS_CACHE_URL, logger: log, commandTimeoutMs: 2_000 });
  await whenReady(cacheConnection(), 10_000);
  nodes.push(await startNode(), await startNode());
  for (let i = 0; i < SOCKETS; i++) users.push(newId());
  // connect in batches, alternating the nodes (what sticky sessions behind the load balancer give)
  for (let i = 0; i < users.length; i += 50) {
    const batch = users.slice(i, i + 50);
    const opened = await Promise.all(batch.map((u, j) => openSocket((nodes[(i + j) % nodes.length] as Node).url, u)));
    for (const s of opened) if (s) sockets.push(s);
  }
}, 300_000);

afterAll(async () => {
  for (const s of sockets) s.close();
  for (const n of nodes) await n.close();
  await closeCache();
});

describe('chat fan-out', () => {
  it('[S11-03] message fan-out p95 < 500 ms locally with 1,000 connected sockets', async () => {
    const connected = sockets.length;
    const threads: string[][] = [];
    for (let i = 0; i + THREAD_SIZE <= connected; i += THREAD_SIZE) threads.push(users.slice(i, i + THREAD_SIZE));
    const threadIds = threads.map(() => newId());

    // steady load: RATE_PER_SECOND messages a second, each to a 10-participant thread
    const started = performance.now();
    for (let m = 0; m < MESSAGES; m++) {
      const t = m % threads.length;
      await send(threadIds[t] as string, threads[t] as string[]);
      const due = started + ((m + 1) * 1_000) / RATE_PER_SECOND;
      const wait = due - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    // bursts to the largest thread (two agencies × 50 participants)
    const big = users.slice(0, Math.min(BIG_THREAD, connected));
    const bigId = newId();
    for (let m = 0; m < BIG_MESSAGES; m++) await send(bigId, big);
    await until(() => pending.size === 0, 30_000);

    const expected = MESSAGES * THREAD_SIZE + BIG_MESSAGES * big.length;
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const max = Math.max(...latencies);
    console.info(
      `[S11-03] chat fan-out: ${connected}/${SOCKETS} sockets on 2 nodes, ${latencies.length}/${expected} deliveries, ` +
        `p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${max.toFixed(1)} ms`,
    );
    expect(connected).toBe(SOCKETS);
    expect(latencies.length).toBe(expected);
    expect(p95).toBeLessThan(500);
  });
});
