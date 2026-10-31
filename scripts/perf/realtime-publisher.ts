// pnpm perf:realtime:publish [--profile smoke|staging|soak] [--users tests/load/.data/dashboard-users.json]
//   [--start-at <ms epoch>] [--sockets n] [--rate n] [--warmup s] [--duration s] [--summary file] [--staging]
//
// The publisher of the realtime load test (S16-01, PLAN §15 "Realtime: 5,000 sockets, message fan-out p95 < 500 ms"),
// run beside `tests/load/realtime.js` on the same load-generator host. It publishes per-user notifications through the
// path workers use — `publishUserEvents` on redis-cache, a valid `NotificationPush` on `/notifications` — at `--rate`
// per second, round robin over the members k6 connects (the first `--sockets` of the tokens file's users), from
// `--start-at` (shared with k6's START_AT; required for staging and soak) to the end of the steady phase. Each payload carries `sentAt` (ms epoch,
// stamped just before the publish): k6 records receive time − `sentAt`, so fan-out = Redis pub/sub → realtime node →
// socket. Both clocks are this host's (k6 and the publisher must run on the same machine; locally the k6 container's
// clock is the Docker Desktop VM's, kept in sync by Docker — k6 counts negative latencies, so a skew shows).
//
// Members and tokens: the users file of `pnpm perf:load:tokens` (tokens minted by `identity.issueAccessToken`, so
// membership, account status and session version are checked; its `--serve` refresh service rotates k6's tokens on
// runs longer than a token's 15-minute life; the publisher needs only the ids). It runs only where `assertLoadTarget`
// allows (a staging target needs --staging).
//
// Env: REDIS_CACHE_URL, DEPLOY_ENV / NODE_ENV, REALTIME_PREFIX_EVENTS (as the workers'). Runbook:
// docs/runbooks/load-suite.md › Realtime.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  cacheConnection,
  closeCache,
  configureCache,
  publishUserEvents,
  type UserEvent,
  whenReady,
} from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { createLogger, type Logger } from '@inmolink/platform/logger';
import {
  connectedUsers,
  EVENT,
  eventsDue,
  type LoadUser,
  type LoadUsersFile,
  loadNotification,
  NAMESPACE,
  type Profile,
  phaseOf,
  recipientOf,
  resolveProfile,
  resolveStartAt,
  socketsOfUser,
  timeline,
} from '../../tests/load/lib/realtime-mix';
import { assertLoadTarget } from './load-sites';

const ROOT = join(import.meta.dirname, '..', '..');
export const DEFAULT_USERS_FILE = join(ROOT, 'tests', 'load', '.data', 'dashboard-users.json');
/** The publisher's pacing tick: events owed since the last one go out in one pipeline. */
const TICK_MS = 20;
/** One pipeline at most (a late tick catches up over several). */
const MAX_BATCH = 1_000;

export function readUsersFile(path: string): LoadUsersFile {
  const file = JSON.parse(readFileSync(path, 'utf8')) as LoadUsersFile;
  if (!Array.isArray(file.users) || file.users.length === 0) throw new Error(`${path} has no users`);
  return file;
}

export interface PublisherOptions {
  users: readonly LoadUser[];
  profile: Profile;
  /** Ms epoch shared with k6 (`START_AT`). */
  startAt: number;
  logger: Logger;
  /** Stop early (Ctrl-C, the driver's k6 exited). */
  signal?: AbortSignal;
}

export interface PublisherReport {
  sent: number;
  /** Events whose `sentAt` is in the steady phase (the ones k6 judges). */
  sentSteady: number;
  /** Deliveries those should make: each event reaches every socket of its member. */
  expectedSteadyDeliveries: number;
  /** Events in failed publishes (redis-cache fails fast; not retried — they count as lost). */
  failed: number;
  /** Steady-phase rate actually published. */
  steadyRate: number;
  /** Largest gap between two publishes, ms (a starved publisher shows as latency in k6). */
  maxTickGapMs: number;
}

/**
 * Publishes `profile.eventRate` notifications a second from `startAt` to the end of the steady phase, round robin
 * over the members with a socket (`connectedUsers`). Paced by the clock (an open model: a slow tick catches up, the
 * rate does not drift). Returns what it sent.
 */
export async function runPublisher(o: PublisherOptions): Promise<PublisherReport> {
  const tl = timeline(o.profile, o.startAt);
  const connected = connectedUsers(o.profile.sockets, o.users.length);
  const report: PublisherReport = {
    sent: 0,
    sentSteady: 0,
    expectedSteadyDeliveries: 0,
    failed: 0,
    steadyRate: 0,
    maxTickGapMs: 0,
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  await sleep(o.startAt - Date.now());
  let seq = 0;
  let last = Date.now();
  while (!o.signal?.aborted) {
    const now = Date.now();
    if (now >= tl.steadyUntil) break;
    report.maxTickGapMs = Math.max(report.maxTickGapMs, now - last);
    last = now;
    const due = Math.min(MAX_BATCH, eventsDue(now - o.startAt, o.profile.eventRate, seq));
    if (due > 0) {
      const sentAt = Date.now();
      const phase = phaseOf(sentAt, tl);
      const events: UserEvent[] = [];
      let deliveries = 0;
      for (let k = 0; k < due; k++) {
        const j = recipientOf(seq + k, connected);
        const user = o.users[j] as LoadUser;
        deliveries += socketsOfUser(j, o.profile.sockets, o.users.length);
        events.push({
          userId: user.userId,
          agencyId: user.agencyId,
          namespace: NAMESPACE,
          event: EVENT,
          data: loadNotification({ agencyId: user.agencyId, id: newId(), sentAt, seq: seq + k }),
        });
      }
      seq += due;
      try {
        await publishUserEvents(events);
        report.sent += due;
        if (phase === 'steady') {
          report.sentSteady += due;
          report.expectedSteadyDeliveries += deliveries;
        }
      } catch (err) {
        report.failed += due;
        if (report.failed === due) o.logger.warn({ err }, 'publish failed (counted as lost)');
      }
    }
    await sleep(TICK_MS - (Date.now() - now));
  }
  report.steadyRate = Math.round((report.sentSteady / o.profile.seconds) * 10) / 10;
  return report;
}

async function main() {
  const { values } = parseArgs({
    options: {
      profile: { type: 'string', default: 'smoke' },
      users: { type: 'string', default: DEFAULT_USERS_FILE },
      'start-at': { type: 'string' },
      sockets: { type: 'string' },
      rate: { type: 'string' },
      warmup: { type: 'string' },
      duration: { type: 'string' },
      summary: { type: 'string' },
      staging: { type: 'boolean', default: false },
    },
  });
  assertLoadTarget(process.env, values.staging);
  // The same names and refusals as k6: the acceptance profiles take no override.
  const profile = resolveProfile({
    PROFILE: values.profile,
    SOCKETS: values.sockets,
    EVENT_RATE: values.rate,
    WARMUP: values.warmup,
    DURATION: values.duration,
  });
  // Staging and soak need the start k6 got as START_AT: two clocks would judge different steady phases.
  const startAt = resolveStartAt(profile.name, values['start-at'], Date.now());
  const log = createLogger({ service: 'perf:realtime-publisher', level: 'info' });
  const file = readUsersFile(values.users);
  await configureCache({ url: process.env.REDIS_CACHE_URL, logger: log });
  await whenReady(cacheConnection(), 10_000);
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  process.once('SIGTERM', () => abort.abort());
  log.info({ profile: profile.name, startAt, users: file.users.length }, 'publishing');
  try {
    const report = await runPublisher({ users: file.users, profile, startAt, logger: log, signal: abort.signal });
    log.info(report, 'realtime publisher done');
    if (values.summary) writeFileSync(values.summary, JSON.stringify(report));
  } finally {
    await closeCache();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
