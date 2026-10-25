import { performance } from 'node:perf_hooks';
import { loadStackEnv } from '@inmolink/db/testing';
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
import { createLogger } from '@inmolink/platform/logger';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * S12-F4 load test: 10,000 per-user events (a ~1 KB notification each, pipelined in batches like the workers' jobs)
 * to 3 realtime nodes' subscriptions on redis-cache, each node owning a third of the connected members (its rooms,
 * `isLocal`). Every node receives every message; it hands on only its own members' events and skips the rest on the
 * `agencyId:userId|` prefix, unparsed. One node is deliberately slow: it stops reading its socket while the burst is
 * published, so Redis buffers the whole burst for it (its `omem` grows), then catches up — below the
 * `client-output-buffer-limit pubsub` it must stay connected. Passes when each node handed on exactly its own events,
 * the slow node really backed up, and no subscriber was disconnected: each node's client id still connected and
 * subscribed, no `close`, and Redis's own `client_output_buffer_limit_disconnections` unchanged.
 */

const EVENTS = 10_000;
const NODES = 3;
const MEMBERS_PER_NODE = 100;
/** Members with no socket on any node (their events are skipped everywhere). */
const OFFLINE = 300;
const BATCH = 500;
/** How long the slow node stops reading (well below the 60 s soft-limit window). */
const STALL_MS = 3_000;
const AGENCY = newId();
const log = createLogger({ service: 'user-events-load', level: 'silent' });

interface Node {
  sub: Redis;
  /** Its Redis client id, taken before subscribing: a dropped and reconnected subscriber gets a new one. */
  clientId: string;
  local: Set<string>;
  /** Events handed on: one for a member of another node would mean the skip failed. */
  delivered: number;
  closes: number;
  stop: () => Promise<void>;
}
const nodes: Node[] = [];

beforeAll(async () => {
  loadStackEnv('test');
  // the prefixed form (REALTIME_PREFIX_EVENTS on), which the skip needs
  await configureCache({ logger: log, commandTimeoutMs: 5_000, prefixUserEvents: true });
  await whenReady(cacheConnection(), 10_000);
  for (let n = 0; n < NODES; n++) {
    const { pub, sub } = pubSubConnections();
    await pub.quit();
    await whenReady(sub, 10_000);
    const node: Node = {
      sub,
      clientId: String(await sub.client('ID')),
      local: new Set(Array.from({ length: MEMBERS_PER_NODE }, () => newId())),
      delivered: 0,
      closes: 0,
      stop: async () => {},
    };
    sub.on('close', () => {
      node.closes += 1;
    });
    const unsubscribe = await subscribeUserEvents(
      sub,
      () => {
        node.delivered += 1;
      },
      log,
      { isLocal: (agencyId, userId) => agencyId === AGENCY && node.local.has(userId) },
    );
    node.stop = async () => {
      await unsubscribe();
      await sub.quit();
    };
    nodes.push(node);
  }
}, 60_000);

afterAll(async () => {
  for (const n of nodes) await n.stop();
  await closeCache();
});

/** Each node's subscription count and output buffer bytes as Redis sees its client (sub 0 = that connection is gone). */
async function clients(): Promise<{ sub: number; omem: number }[]> {
  const list = String(await cacheConnection().call('CLIENT', 'LIST'));
  const byId = new Map<string, { sub: number; omem: number }>();
  for (const line of list.split('\n')) {
    const fields = new Map(line.split(' ').map((kv) => kv.split('=') as [string, string]));
    const id = fields.get('id');
    if (id) byId.set(id, { sub: Number(fields.get('sub') ?? 0), omem: Number(fields.get('omem') ?? 0) });
  }
  return nodes.map((n) => byId.get(n.clientId) ?? { sub: 0, omem: 0 });
}

/** Clients Redis has dropped over their output buffer limit since it started (INFO stats). */
async function bufferDisconnections(): Promise<number> {
  const info = String(await cacheConnection().info('stats'));
  return Number(/client_output_buffer_limit_disconnections:(\d+)/.exec(info)?.[1] ?? 0);
}

it('[S12-F4] 10k events to 3 nodes (one stalled): each node hands on only its members’ events, skips the rest, and no subscriber is disconnected', async () => {
  const offline = Array.from({ length: OFFLINE }, () => newId());
  const recipients = [...nodes.flatMap((n) => [...n.local]), ...offline];
  const expected = nodes.map(() => 0);
  const notification = {
    id: newId(),
    type: 'CHAT_MESSAGE',
    params: { actor: 'Load test', subject: 'x'.repeat(800) },
    link: '/chat/x',
    actorUserId: null,
    readAt: null,
    createdAt: new Date().toISOString(),
  };
  const events: UserEvent[] = [];
  for (let i = 0; i < EVENTS; i++) {
    const userId = recipients[i % recipients.length] as string;
    const owner = nodes.findIndex((n) => n.local.has(userId));
    if (owner >= 0) expected[owner] = (expected[owner] ?? 0) + 1;
    events.push({
      userId,
      agencyId: AGENCY,
      namespace: '/notifications',
      event: 'notification',
      data: { agencyId: AGENCY, notification },
    });
  }
  expect((await clients()).map((c) => c.sub)).toEqual(nodes.map(() => 1));
  const droppedBefore = await bufferDisconnections();

  // the slow node stops reading its socket: Redis keeps the burst in that client's output buffer
  const slow = nodes[0] as Node;
  const stream = (slow.sub as unknown as { stream: { pause(): void; resume(): void } }).stream;
  stream.pause();
  let peakOmem = 0;
  const started = performance.now();
  try {
    for (let i = 0; i < events.length; i += BATCH) await publishUserEvents(events.slice(i, i + BATCH));
    const until = Date.now() + STALL_MS;
    while (Date.now() < until) {
      peakOmem = Math.max(peakOmem, (await clients())[0]?.omem ?? 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    stream.resume();
  }
  const published = performance.now() - started;
  const deadline = Date.now() + 60_000;
  while (nodes.some((n, i) => n.delivered < (expected[i] ?? 0)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const total = performance.now() - started;
  await new Promise((resolve) => setTimeout(resolve, 200)); // anything handed on late would still show
  console.info(
    `[S12-F4] ${EVENTS} user events to ${NODES} nodes: published (and stalled ${STALL_MS} ms) in ` +
      `${published.toFixed(0)} ms, handed on in ${total.toFixed(0)} ms; per node ` +
      `${nodes.map((n) => n.delivered).join('/')} of ${expected.join('/')} (the rest skipped unparsed); slow node ` +
      `peak output buffer ${(peakOmem / 1_048_576).toFixed(1)} MB`,
  );
  expect(nodes.map((n) => n.delivered)).toEqual(expected);
  // it really backed up (most of the burst sat in Redis for it), and was not dropped for it
  expect(peakOmem).toBeGreaterThan(1_048_576);
  expect(nodes.map((n) => n.closes)).toEqual(nodes.map(() => 0));
  expect((await clients()).map((c) => c.sub)).toEqual(nodes.map(() => 1));
  expect(await bufferDisconnections()).toBe(droppedBefore);
});
