// Realtime load test (S16-01, PLAN §15): sockets held on `/notifications`, notification fan-out p95 < 500 ms.
//
//   k6 run -e BASE_URL=https://realtime.staging.example -e ORIGIN=https://app.staging.example -e PROFILE=staging \
//          -e START_AT=<ms epoch> -e USERS_FILE=.data/dashboard-users.json realtime.js
//
// Each VU holds one socket: Engine.IO v4 / Socket.io v4 spoken over a plain WebSocket (`tests/load/lib/realtime-mix.ts`:
// k6 has no Socket.io client), connected to the notifications namespace with the member's realtime token in the
// handshake `auth`, answering the server's pings. `scripts/perf/realtime-publisher.ts` runs beside it on the same host
// and publishes notifications through redis-cache (the path workers use) with `sentAt` in the payload; each one received
// records receive time − `sentAt` (`realtime_fanout_ms`, tagged with the phase it was sent in).
//
// Tokens live 15 minutes and the server closes a socket when its token expires: a run longer than the tokens file's
// lifetime rotates each socket make-before-break (a fresh token from the refresh service of `pnpm perf:load:tokens
// --serve`, `GET <refresh>/tokens/<index>`; a new socket; then the old one leaves), as the dashboard reconnects with a
// fresh token.
//
// Env: BASE_URL (the realtime origin), ORIGIN (an allowed dashboard origin: the server refuses any other), USERS_FILE
// (`pnpm perf:load:tokens`: `{ users: [{ agencyId, userId, api, realtime, index }], issuedAt, expiresAt, refresh }`,
// default ./.data/dashboard-users.json),
// PROFILE (smoke | staging | soak), SOCKETS, DURATION (s), WARMUP (s), RAMP (s), EVENT_RATE (/s, the publisher's: the
// delivery threshold derives the steady deliveries it owes from it), P95_MS, START_AT (ms epoch shared with the
// publisher's --start-at; required for staging and soak, smoke defaults to the scenario start), TOKENS_REFRESH_URL (the
// refresh service as this host reaches it, else the file's `refresh.url`), SUMMARY_FILE (k6's summary as JSON).
// Runbook: docs/runbooks/load-suite.md › Realtime.
import encoding from 'k6/encoding';
import exec from 'k6/execution';
import { WebSocket } from 'k6/experimental/websockets';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';
import { clearTimeout, setTimeout } from 'k6/timers';
import {
  assertTokensCover,
  connectAt,
  connectedUsers,
  decodeFrame,
  EVENT,
  encodeConnect,
  encodeDisconnect,
  fanoutSample,
  jwtExpiry,
  METRICS,
  NAMESPACE,
  PONG,
  phaseOf,
  resolveProfile,
  resolveStartAt,
  rotateAt,
  scenarios,
  socketUrl,
  summaryText,
  thresholds,
  timeline,
  userIndexFor,
  usersNeeded,
} from './lib/realtime-mix.ts';

const profile = resolveProfile(__ENV);
const URL = socketUrl(__ENV.BASE_URL || 'http://127.0.0.1:4002');
const ORIGIN = __ENV.ORIGIN || 'http://localhost:3000';
/** Staging and soak refuse to run without it (0: smoke, each VU uses the scenario start). */
const START_AT = resolveStartAt(profile.name, __ENV.START_AT, 0);
/** Secrets: keep the file off the repo (`tests/load/.data/`). */
const FILE = JSON.parse(open(__ENV.USERS_FILE || './.data/dashboard-users.json'));
const USERS = FILE.users;
/** Lane A's token refresh service (`pnpm perf:load:tokens --serve`), or none: the tokens then last one lifetime. */
const REFRESH_URL = (__ENV.TOKENS_REFRESH_URL || FILE.refresh?.url || '').replace(/\/$/, '');
const REFRESH_SECRET = FILE.refresh?.secret || '';
const CAN_ROTATE = Boolean(REFRESH_URL && REFRESH_SECRET);
/** A namespace connect not acknowledged within this long counts as failed (and is retried). */
const CONNECT_TIMEOUT_MS = 10_000;

const b64url = (s) => encoding.b64decode(s, 'rawurl', 's');
// A START_AT in the future (the publisher and k6 share it) delays every socket: allow for it in maxDuration.
const startDelaySeconds = START_AT ? Math.max(0, (START_AT - Date.now()) / 1_000) : 0;

export const options = {
  scenarios: scenarios(profile, startDelaySeconds),
  // The delivery threshold: the publisher sends to the first members of the same file, so k6 derives what it owes.
  thresholds: thresholds(profile, USERS.length),
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  setupTimeout: '1m',
  userAgent: 'inmolink-load-test/S16-01 (k6)',
};

const fanout = new Trend(METRICS.fanout, true);
const connectMs = new Trend(METRICS.connect, true);
const connectOk = new Rate(METRICS.connectOk);
const received = new Counter(METRICS.received);
const duplicates = new Counter(METRICS.duplicates);
const unexpected = new Counter(METRICS.unexpected);
const rotations = new Counter(METRICS.rotations);
const negative = new Counter(METRICS.negative);

/** Refuses a run the members or their tokens cannot carry, before any socket opens. */
export function setup() {
  const needed = usersNeeded(profile.sockets);
  if (USERS.length < needed) {
    exec.test.abort(
      `${USERS.length} load-test members for ${profile.sockets} sockets: ${needed} needed (≤ 4 sockets each)`,
    );
  }
  const startAt = START_AT || Date.now();
  const used = USERS.slice(0, connectedUsers(profile.sockets, USERS.length));
  try {
    assertTokensCover(
      used.map((u) => jwtExpiry(u.realtime, b64url)),
      timeline(profile, startAt).closeAt,
      CAN_ROTATE,
    );
  } catch (err) {
    exec.test.abort(String(err.message ?? err));
  }
}

let warned = 0;
const warn = (msg) => {
  if (warned++ < 5) console.warn(`VU ${exec.vu.idInTest}: ${msg}`);
};

/** A fresh realtime token for the member at `index` of the file from the refresh service, or null. */
function freshToken(index) {
  const res = http.get(`${REFRESH_URL}/tokens/${index}`, {
    headers: { Authorization: `Bearer ${REFRESH_SECRET}` },
    tags: { name: 'token_refresh' },
  });
  if (res.status !== 200) {
    warn(`token refresh ${res.status}`);
    return null;
  }
  return JSON.parse(String(res.body)).realtime ?? null;
}

/** One VU = one socket held from its slot on the ramp to the planned close (rotating its token when needed). */
export function holdSocket() {
  const index = exec.vu.idInTest - 1;
  const userIndex = userIndexFor(index, USERS.length);
  const member = USERS[userIndex];
  /** The refresh service's key: the member's `index` in the file (its position when the file has none). */
  const memberIndex = member.index ?? userIndex;
  let token = member.realtime;
  const startAt = START_AT || exec.scenario.startTime;
  const tl = timeline(profile, startAt);
  /** Notification ids this socket's member already got (a rotation overlaps two sockets; delivery is at least once). */
  const seen = new Map();
  let current = null;
  let closing = false;
  // Zero samples, so the counters exist (and their thresholds are judged) in a run where nothing goes wrong.
  received.add(0, { phase: 'steady' });
  unexpected.add(0);
  duplicates.add(0);
  rotations.add(0);
  negative.add(0);

  const onNotification = (push) => {
    const s = fanoutSample(push, Date.now());
    if (!s) return;
    if (seen.has(s.id)) {
      duplicates.add(1);
      return;
    }
    seen.set(s.id, true);
    if (seen.size > 2_000) seen.delete(seen.keys().next().value);
    const phase = phaseOf(s.sentAt, tl);
    received.add(1, { phase });
    fanout.add(s.latencyMs, { phase });
    if (s.latencyMs < 0) negative.add(1);
  };

  /**
   * Opens a socket and connects the namespace. `onReady(conn)` once the server acknowledged it; `onFail()` when it
   * did not (refused, closed, timed out); `onLost(conn)` when a ready socket is dropped by anything but the plan.
   */
  const connect = (withToken, onReady, onFail, onLost) => {
    const conn = { ws: null, planned: false, rotateTimer: null };
    const t0 = Date.now();
    let settled = false;
    const ws = new WebSocket(URL, null, { headers: { Origin: ORIGIN }, tags: { name: 'realtime' } });
    conn.ws = ws;
    const fail = (why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connectOk.add(false, { phase: phaseOf(Date.now(), tl) });
      warn(`connect failed: ${why}`);
      conn.planned = true;
      ws.close();
      if (!closing) onFail();
    };
    const timer = setTimeout(() => fail('timeout'), CONNECT_TIMEOUT_MS);
    const lost = (why) => {
      if (conn.planned) return;
      conn.planned = true;
      unexpected.add(1);
      warn(`socket lost: ${why}`);
      clearTimeout(conn.rotateTimer);
      ws.close();
      if (!closing) onLost(conn);
    };
    ws.addEventListener('message', (e) => {
      const f = decodeFrame(String(e.data));
      switch (f.kind) {
        case 'open':
          ws.send(encodeConnect(NAMESPACE, { token: withToken }));
          break;
        case 'ping':
          ws.send(PONG);
          break;
        case 'connect':
          if (f.nsp !== NAMESPACE || settled) break;
          settled = true;
          clearTimeout(timer);
          connectOk.add(true, { phase: phaseOf(Date.now(), tl) });
          connectMs.add(Date.now() - t0, { phase: phaseOf(Date.now(), tl) });
          if (closing) {
            conn.planned = true;
            ws.close();
            break;
          }
          onReady(conn);
          break;
        case 'connect_error':
          if (f.nsp === NAMESPACE) fail(f.message);
          break;
        case 'disconnect':
          if (f.nsp === NAMESPACE) lost('server disconnect');
          break;
        case 'close':
          lost('engine close');
          break;
        case 'event':
          if (f.nsp === NAMESPACE && f.event === EVENT) onNotification(f.args[0]);
          break;
        default:
          break;
      }
    });
    ws.addEventListener('close', () => {
      if (!settled) fail('closed');
      else lost('closed');
    });
    ws.addEventListener('error', (e) => warn(`socket error: ${e.error}`));
    return conn;
  };

  const leave = (conn) => {
    if (!conn) return;
    conn.planned = true;
    clearTimeout(conn.rotateTimer);
    try {
      conn.ws.send(encodeDisconnect(NAMESPACE));
    } catch {
      // already closing
    }
    conn.ws.close();
  };

  const scheduleRotation = (conn) => {
    if (!CAN_ROTATE) return;
    const exp = jwtExpiry(token, b64url);
    const at = exp === null ? null : rotateAt(exp, tl.closeAt, Math.random);
    if (at === null) return;
    conn.rotateTimer = setTimeout(rotate, Math.max(0, at - Date.now()));
  };

  // Make-before-break: the new socket is in the member's room before the old one leaves, so no event falls between.
  const rotate = () => {
    if (closing) return;
    const fresh = freshToken(memberIndex);
    if (!fresh) {
      setTimeout(rotate, 5_000);
      return;
    }
    token = fresh;
    connect(
      fresh,
      (conn) => {
        const old = current;
        current = conn;
        rotations.add(1);
        leave(old);
        scheduleRotation(conn);
      },
      () => setTimeout(rotate, 2_000),
      reconnectLater,
    );
  };

  const openSocket = () => {
    if (closing) return;
    // A token about to expire (a reconnect late in its life) is replaced first, when a token source is set.
    const exp = jwtExpiry(token, b64url);
    if (CAN_ROTATE && exp !== null && exp * 1_000 < Date.now() + 2 * 60_000) token = freshToken(memberIndex) ?? token;
    connect(
      token,
      (conn) => {
        current = conn;
        scheduleRotation(conn);
      },
      () => setTimeout(openSocket, 1_000 + Math.floor(Math.random() * 2_000)),
      reconnectLater,
    );
  };

  function reconnectLater(conn) {
    if (conn !== current) return;
    current = null;
    setTimeout(openSocket, 1_000);
  }

  setTimeout(openSocket, Math.max(0, connectAt(index, profile, startAt) - Date.now()));
  setTimeout(
    () => {
      closing = true;
      leave(current);
      current = null;
    },
    Math.max(0, tl.closeAt - Date.now()),
  );
}

export function handleSummary(data) {
  const out = { stdout: summaryText(data, profile, USERS.length) };
  if (__ENV.SUMMARY_FILE) out[__ENV.SUMMARY_FILE] = JSON.stringify(data);
  return out;
}
