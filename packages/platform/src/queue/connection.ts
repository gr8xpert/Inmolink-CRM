import { context, trace } from '@opentelemetry/api';
import { Queue } from 'bullmq';
import { BullMQOtel } from 'bullmq-otel';
import { Redis, type RedisOptions } from 'ioredis';
import { loadConfig, redisEnv } from '../config';
import { createLogger, type Logger } from '../logger';
import { Fairness } from './fairness';

export interface QueueConfig {
  /** redis-queue (noeviction + AOF). Defaults to `REDIS_QUEUE_URL`. */
  url?: string;
  /** Key prefix for every queue; tests use their own to stay isolated. */
  prefix?: string;
  logger?: Logger;
}

interface State {
  url: string;
  prefix: string;
  logger: Logger;
  producer?: Redis;
  fairness?: Fairness;
  telemetry?: BullMQOtel;
  queues: Map<string, Queue>;
}

let state: State | undefined;

// ioredis 6 defaults to RESP3; BullMQ's scripts expect RESP2 replies, so the protocol is pinned.
const base: RedisOptions = { protocol: 2, connectionName: 'inmolink-queue' };

/** Sets the Redis URL and prefix. Apps call it once at boot; without it the first use reads `REDIS_QUEUE_URL`. */
export async function configureQueue(config: QueueConfig = {}): Promise<void> {
  await closeQueues();
  state = {
    url: config.url ?? loadConfig({ REDIS_QUEUE_URL: redisEnv.REDIS_QUEUE_URL }).REDIS_QUEUE_URL,
    prefix: config.prefix ?? 'inl',
    logger: config.logger ?? createLogger({ service: 'queue', level: process.env.LOG_LEVEL }),
    queues: new Map(),
  };
}

function current(): State {
  if (!state) {
    state = {
      url: loadConfig({ REDIS_QUEUE_URL: redisEnv.REDIS_QUEUE_URL }).REDIS_QUEUE_URL,
      prefix: 'inl',
      logger: createLogger({ service: 'queue', level: process.env.LOG_LEVEL }),
      queues: new Map(),
    };
  }
  return state;
}

export const queuePrefix = () => current().prefix;
export const queueLogger = () => current().logger;

/**
 * Shared producer connection (enqueue + fairness bookkeeping). Commands fail after one reconnect
 * attempt instead of hanging, so the outbox dispatcher can retry an event later rather than stall.
 */
export function producerConnection(): Redis {
  const s = current();
  if (!s.producer) {
    s.producer = new Redis(s.url, { ...base, maxRetriesPerRequest: 1, enableAutoPipelining: true });
    s.producer.on('error', (err) => s.logger.warn({ err }, 'redis-queue producer error'));
  }
  return s.producer;
}

/** Fair-share bookkeeping on the producer connection. */
export function fairnessFor(): Fairness {
  const s = current();
  s.fairness ??= new Fairness(producerConnection(), s.prefix);
  return s.fairness;
}

/** A dedicated worker connection: blocking commands must retry forever (BullMQ requirement). */
export function workerConnection(): Redis {
  const s = current();
  const conn = new Redis(s.url, { ...base, maxRetriesPerRequest: null });
  conn.on('error', (err) => s.logger.warn({ err }, 'redis-queue worker error'));
  return conn;
}

/**
 * BullMQ's OpenTelemetry bridge (S0-10): a job carries its producer's trace context and the worker's
 * span continues it; job counts and durations become metrics. Created on first use — after
 * `startTelemetry()` — so it binds the real meter provider.
 */
export function queueTelemetry(): BullMQOtel {
  const s = current();
  s.telemetry ??= new BullMQOtel({ tracerName: '@inmolink/queue', meterName: '@inmolink/queue', enableMetrics: true });
  return s.telemetry;
}

/**
 * The caller's trace context as BullMQ job metadata, captured at enqueue time: batched adds
 * (`addBatched`) are sent later from the flushing caller's context, which may belong to another trace.
 */
export function traceMetadata(): string | undefined {
  if (!trace.getActiveSpan()) return undefined;
  return queueTelemetry().contextManager.getMetadata(context.active());
}

/** One BullMQ queue per pool (plus `<pool>.dead` for dead letters). */
export function queueFor(name: string): Queue {
  const s = current();
  let q = s.queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: producerConnection(), prefix: s.prefix, telemetry: queueTelemetry() });
    q.on('error', (err) => s.logger.warn({ err, queue: name }, 'queue error'));
    s.queues.set(name, q);
  }
  return q;
}

/** Graceful shutdown for producers. Workers are closed by the handle `registerPool` returns. */
export async function closeQueues(): Promise<void> {
  const s = state;
  state = undefined;
  if (!s) return;
  await Promise.all([...s.queues.values()].map((q) => q.close()));
  await s.producer?.quit().catch(() => s.producer?.disconnect());
}
