/**
 * Realtime load test (S16-01, PLAN §15 "Realtime: 5,000 sockets, message fan-out p95 < 500 ms"): the Socket.io wire
 * format k6 speaks over a plain WebSocket, the load profiles, the thresholds that encode the acceptance check, the
 * run's timeline and the notification payload the publisher sends. Pure — no k6 module, no Node module — so k6
 * (`tests/load/realtime.js`), the publisher (`scripts/perf/realtime-publisher.ts`) and Vitest (`realtime-mix.test.ts`)
 * run the same code.
 *
 * Fan-out latency is measured end to end on the path workers use: the publisher stamps `sentAt` (ms epoch) into the
 * notification, publishes it on redis-cache (`publishUserEvents`), the realtime node hands it to the recipient's
 * sockets, and k6 records receive time − `sentAt`. Both clocks are the load generator's: publisher and k6 run on the
 * same host (staging: the load-generator box; locally: Windows host and the Docker Desktop VM, whose clock Docker
 * keeps in sync to a few ms — a negative latency is counted, so a skewed clock shows).
 */

/** The acceptance check (PLAN §15): 5,000 sockets held 15 minutes, fan-out p95 < 500 ms. */
export const SLO = {
  sockets: 5_000,
  seconds: 15 * 60,
  p95Ms: 500,
  /** Sockets that open (namespace connect acknowledged) out of every attempt. */
  connectSuccess: 0.999,
  /** Steady-phase deliveries that arrive out of the ones the publisher's rate owes (`expectedSteadyDeliveries`). */
  deliveredShare: 0.999,
} as const;

/** The Socket.io namespace and event the test listens on (`@inmolink/contracts`; a unit test keeps them equal). */
export const NAMESPACE = '/notifications';
export const EVENT = 'notification';

export interface Profile {
  /** Sockets held open (one per k6 VU). */
  sockets: number;
  /** Sockets open evenly over this many seconds from the start (not judged). */
  rampSeconds: number;
  /** From the start to the steady phase (≥ the ramp: every socket is open before it is judged). */
  warmupSeconds: number;
  /** Steady phase length, seconds (what the thresholds judge: events sent in it). */
  seconds: number;
  /** After the steady phase: publishing stops, in-flight events arrive, then the sockets close (not judged). */
  tailSeconds: number;
  /** Notifications published per second over all connected users (each reaches every socket of its user). */
  eventRate: number;
  p95Ms: number;
  connectSuccess: number;
}

/**
 * - `smoke`: `pnpm perf:smoke realtime` — a short local run with a few sockets against the docker `test` stack.
 * - `staging`: the acceptance run (H4) — 5,000 sockets, 15 minutes steady, 500 notifications a second (each member
 *   one every few seconds: far above a real dashboard's rate, so the fan-out path is loaded, not idle).
 * - `soak`: PLAN §15 soak at 50 % load — 2,500 sockets for 24 h (the soak sampler judges memory and connections).
 */
export const PROFILES = {
  smoke: {
    sockets: 50,
    rampSeconds: 10,
    warmupSeconds: 15,
    seconds: 60,
    tailSeconds: 5,
    eventRate: 20,
    p95Ms: SLO.p95Ms,
    connectSuccess: SLO.connectSuccess,
  },
  staging: {
    sockets: SLO.sockets,
    rampSeconds: 120,
    warmupSeconds: 150,
    seconds: SLO.seconds,
    tailSeconds: 10,
    eventRate: 500,
    p95Ms: SLO.p95Ms,
    connectSuccess: SLO.connectSuccess,
  },
  soak: {
    sockets: SLO.sockets / 2,
    rampSeconds: 120,
    warmupSeconds: 300,
    seconds: 24 * 3_600,
    tailSeconds: 10,
    eventRate: 250,
    p95Ms: SLO.p95Ms,
    connectSuccess: SLO.connectSuccess,
  },
} as const satisfies Record<string, Profile>;
export type ProfileName = keyof typeof PROFILES;

/** Profiles whose numbers are an acceptance check (the 5,000-socket run; the 24 h soak): no overrides. */
export const ACCEPTANCE_PROFILE: ProfileName = 'staging';
const FIXED_PROFILES: ReadonlySet<ProfileName> = new Set([ACCEPTANCE_PROFILE, 'soak']);
const OVERRIDES = ['SOCKETS', 'DURATION', 'WARMUP', 'RAMP', 'EVENT_RATE', 'P95_MS'] as const;

const positive = (name: string, v: string | undefined): number | undefined => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
};

/**
 * The profile named by `PROFILE` (default smoke), with `SOCKETS`, `DURATION` (s), `WARMUP` (s), `RAMP` (s),
 * `EVENT_RATE` (/s) and `P95_MS` overrides — except the acceptance profiles, which refuse them. The warm-up is never
 * shorter than the ramp.
 */
export function resolveProfile(env: Record<string, string | undefined>): Profile & { name: ProfileName } {
  const name = (env.PROFILE ?? 'smoke') as ProfileName;
  const base: Profile | undefined = PROFILES[name];
  if (!base) throw new Error(`PROFILE must be one of ${Object.keys(PROFILES).join(', ')}`);
  const overridden = OVERRIDES.filter((k) => env[k] !== undefined && env[k] !== '');
  if (FIXED_PROFILES.has(name) && overridden.length > 0) {
    throw new Error(`PROFILE=${name} is an acceptance check: no ${overridden.join(', ')} override`);
  }
  const rampSeconds = positive('RAMP', env.RAMP) ?? base.rampSeconds;
  return {
    ...base,
    name,
    sockets: Math.round(positive('SOCKETS', env.SOCKETS) ?? base.sockets),
    rampSeconds,
    warmupSeconds: Math.max(rampSeconds, positive('WARMUP', env.WARMUP) ?? base.warmupSeconds),
    seconds: positive('DURATION', env.DURATION) ?? base.seconds,
    eventRate: positive('EVENT_RATE', env.EVENT_RATE) ?? base.eventRate,
    p95Ms: positive('P95_MS', env.P95_MS) ?? base.p95Ms,
  };
}

/**
 * The run's start (ms epoch) shared by k6 and the publisher (`START_AT` / `--start-at`). The acceptance profiles
 * require it: without it each side starts its own clock, the steady phases drift apart and the delivery threshold
 * judges the wrong window. Smoke falls back to `fallback` (k6: the scenario start; the publisher: now).
 */
export function resolveStartAt(name: ProfileName, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') {
    if (FIXED_PROFILES.has(name)) {
      throw new Error(`PROFILE=${name} needs START_AT / --start-at (one ms epoch for k6 and the publisher)`);
    }
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error('START_AT / --start-at must be a ms epoch');
  return n;
}

/** The run's clock (ms epoch), from one start shared by k6 and the publisher (`START_AT` / `--start-at`). */
export interface Timeline {
  startAt: number;
  /** Events sent from here … */
  steadyFrom: number;
  /** … to here are judged (sent strictly before). */
  steadyUntil: number;
  /** Planned close of every socket (after the tail). */
  closeAt: number;
}

export function timeline(p: Profile, startAt: number): Timeline {
  const steadyFrom = startAt + p.warmupSeconds * 1_000;
  const steadyUntil = steadyFrom + p.seconds * 1_000;
  return { startAt, steadyFrom, steadyUntil, closeAt: steadyUntil + p.tailSeconds * 1_000 };
}

export type Phase = 'warmup' | 'steady' | 'tail';

/** The phase an instant belongs to: an event is judged by when it was sent, a connect by when it happened. */
export function phaseOf(t: number, tl: Timeline): Phase {
  if (t < tl.steadyFrom) return 'warmup';
  return t < tl.steadyUntil ? 'steady' : 'tail';
}

/** When socket `index` (0-based) opens: evenly over the ramp, so the node sees a steady connect rate. */
export function connectAt(index: number, p: Profile, startAt: number): number {
  return startAt + Math.floor((index / Math.max(1, p.sockets)) * p.rampSeconds * 1_000);
}

/** How long k6 may run the single iteration that holds a socket: until the planned close plus a margin. */
export function maxDurationSeconds(p: Profile, startDelaySeconds = 0): number {
  return Math.ceil(startDelaySeconds + p.warmupSeconds + p.seconds + p.tailSeconds + 60);
}

/** k6 `scenarios`: one VU per socket, one iteration each that holds its socket until the planned close. */
export function scenarios(p: Profile, startDelaySeconds = 0): Record<string, Record<string, unknown>> {
  return {
    sockets: {
      executor: 'per-vu-iterations',
      exec: 'holdSocket',
      vus: p.sockets,
      iterations: 1,
      maxDuration: `${maxDurationSeconds(p, startDelaySeconds)}s`,
      gracefulStop: '30s',
    },
  };
}

/** Custom k6 metric names (realtime.js defines them; the summary reads them). */
export const METRICS = {
  /** Trend (ms): receive time − `sentAt`, tagged with the phase the event was sent in. */
  fanout: 'realtime_fanout_ms',
  /** Trend (ms): WebSocket opened → namespace connect acknowledged (`40/notifications,{sid}`). */
  connect: 'realtime_connect_ms',
  /** Rate: namespace connects acknowledged out of attempts (connect errors, refused upgrades, timeouts fail). */
  connectOk: 'realtime_connect_ok',
  /** Counter: notifications received (first copy per socket). */
  received: 'realtime_received',
  /** Counter: the same notification twice on one socket's user (at least once delivery; rotation overlap). */
  duplicates: 'realtime_duplicates',
  /** Counter: sockets closed or disconnected by anything but the test's own plan. */
  unexpected: 'realtime_unexpected_disconnects',
  /** Counter: make-before-break reconnects with a fresh token (tokens live 15 minutes). */
  rotations: 'realtime_token_rotations',
  /** Counter: events received before their `sentAt` (clock skew between publisher and k6). */
  negative: 'realtime_negative_latency',
} as const;

const STEADY = '{phase:steady}';

/**
 * The deliveries the steady phase owes, as the publisher sends them: `eventRate` a second for `seconds`, round robin
 * over the connected members (`recipientOf`), each event reaching every socket of its member — over a whole round the
 * members hold all `sockets`, so an event averages sockets ÷ connected deliveries. k6 derives it from the profile and
 * the users file it shares with the publisher (no number to hand over on staging); the publisher's own count
 * (`expectedSteadyDeliveries` in its report) differs by at most a pacing tick and a partial round.
 */
export function expectedSteadyDeliveries(p: Profile, users: number): number {
  const connected = connectedUsers(p.sockets, users);
  if (connected === 0) return 0;
  return (p.eventRate * p.seconds * p.sockets) / connected;
}

/** The least steady-phase deliveries that pass: `SLO.deliveredShare` of the expected (rounded up). */
export const minSteadyDeliveries = (p: Profile, users: number) =>
  Math.ceil(SLO.deliveredShare * expectedSteadyDeliveries(p, users));

/**
 * k6 `thresholds` — the acceptance check as code: fan-out p95 under budget for events sent in the steady phase,
 * ≥ 99.9 % of the deliveries those events owe arrived (`minSteadyDeliveries`: a dropped event fails the run, not just
 * a slow one), ≥ 99.9 % of socket connects succeed, and no socket was dropped by the server (token-expiry rotations
 * are planned and not counted). `users`: the members in the users file (k6 and the publisher read the same one).
 */
export function thresholds(p: Profile, users: number): Record<string, string[]> {
  return {
    [`${METRICS.fanout}${STEADY}`]: [`p(95)<${p.p95Ms}`],
    [`${METRICS.received}${STEADY}`]: [`count>=${Math.max(1, minSteadyDeliveries(p, users))}`],
    [METRICS.connectOk]: [`rate>${p.connectSuccess}`],
    [METRICS.unexpected]: ['count<1'],
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Engine.IO v4 / Socket.io v4 over a plain WebSocket (`transport=websocket`, no long-polling, no binary attachments).

/** The WebSocket URL of a Socket.io v4 server: `ws(s)://host/socket.io/?EIO=4&transport=websocket`. */
export function socketUrl(baseUrl: string, path = '/socket.io/'): string {
  const base = baseUrl.replace(/\/$/, '').replace(/^http(s?):\/\//, 'ws$1://');
  return `${base}${path}?EIO=4&transport=websocket`;
}

/** Engine.IO `pong` — the answer to every server `ping` (`2`). */
export const PONG = '3';

/** Socket.io CONNECT to a namespace with the handshake `auth` payload: `40/notifications,{"token":"…"}`. */
export function encodeConnect(nsp: string, auth?: Record<string, unknown>): string {
  const prefix = nsp === '/' ? '' : `${nsp},`;
  return `40${prefix}${auth ? JSON.stringify(auth) : ''}`;
}

/** Socket.io DISCONNECT from a namespace (a client leaving on purpose): `41/notifications,`. */
export function encodeDisconnect(nsp: string): string {
  return nsp === '/' ? '41' : `41${nsp},`;
}

/** Socket.io EVENT: `42/notifications,["event",…args]` (no ack id). */
export function encodeEvent(nsp: string, event: string, ...args: unknown[]): string {
  const prefix = nsp === '/' ? '' : `${nsp},`;
  return `42${prefix}${JSON.stringify([event, ...args])}`;
}

export type Frame =
  | { kind: 'open'; sid: string; pingInterval: number; pingTimeout: number; maxPayload?: number }
  | { kind: 'close' }
  | { kind: 'ping' }
  | { kind: 'pong' }
  | { kind: 'noop' }
  | { kind: 'connect'; nsp: string; sid: string | null }
  | { kind: 'connect_error'; nsp: string; message: string }
  | { kind: 'disconnect'; nsp: string }
  | { kind: 'event'; nsp: string; event: string; args: unknown[]; ackId: number | null }
  | { kind: 'ack'; nsp: string; ackId: number; args: unknown[] }
  | { kind: 'unknown'; raw: string };

const parseJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** One WebSocket text frame from the server (one Engine.IO packet: the WebSocket transport never batches). */
export function decodeFrame(raw: string): Frame {
  const unknown: Frame = { kind: 'unknown', raw };
  switch (raw[0]) {
    case '0': {
      const o = parseJson(raw.slice(1)) as Record<string, unknown> | undefined;
      if (!o || typeof o.sid !== 'string') return unknown;
      return {
        kind: 'open',
        sid: o.sid,
        pingInterval: Number(o.pingInterval ?? 25_000),
        pingTimeout: Number(o.pingTimeout ?? 20_000),
        ...(typeof o.maxPayload === 'number' ? { maxPayload: o.maxPayload } : {}),
      };
    }
    case '1':
      return { kind: 'close' };
    case '2':
      return { kind: 'ping' };
    case '3':
      return { kind: 'pong' };
    case '6':
      return { kind: 'noop' };
    case '4':
      return decodeSocketIo(raw.slice(1), raw);
    default:
      return unknown;
  }
}

/** A Socket.io packet (the Engine.IO `message` body): `<type>[<n>-][/nsp,][ackId][json]`. */
function decodeSocketIo(s: string, raw: string): Frame {
  const unknown: Frame = { kind: 'unknown', raw };
  const type = s[0];
  let i = 1;
  // binary packets (5, 6) announce their attachments: not sent by this server's JSON events, so unsupported
  if (type === '5' || type === '6') return unknown;
  let nsp = '/';
  if (s[i] === '/') {
    const comma = s.indexOf(',', i);
    if (comma < 0) {
      nsp = s.slice(i);
      i = s.length;
    } else {
      nsp = s.slice(i, comma);
      i = comma + 1;
    }
  }
  let digits = '';
  while (i < s.length && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) digits += s[i++];
  const body = s.slice(i);
  const data = body === '' ? undefined : parseJson(body);
  if (body !== '' && data === undefined) return unknown;
  switch (type) {
    case '0': {
      const sid = (data as { sid?: unknown } | undefined)?.sid;
      return { kind: 'connect', nsp, sid: typeof sid === 'string' ? sid : null };
    }
    case '1':
      return { kind: 'disconnect', nsp };
    case '2': {
      if (!Array.isArray(data) || typeof data[0] !== 'string') return unknown;
      return { kind: 'event', nsp, event: data[0], args: data.slice(1), ackId: digits === '' ? null : Number(digits) };
    }
    case '3':
      if (digits === '' || !Array.isArray(data)) return unknown;
      return { kind: 'ack', nsp, ackId: Number(digits), args: data };
    case '4': {
      const message = (data as { message?: unknown } | undefined)?.message;
      return { kind: 'connect_error', nsp, message: typeof message === 'string' ? message : String(data ?? '') };
    }
    default:
      return unknown;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Payload, tokens, users.

/** The notification type the load test sends (a real type: the realtime node validates `NotificationPush`). */
export const LOAD_NOTIFICATION_TYPE = 'TASK_DUE';

/**
 * A valid `NotificationPush` (`@inmolink/contracts`) carrying the publisher's clock: `params.sentAt` (ms epoch) and
 * `params.seq` (the publisher's sequence number). The realtime node drops anything that does not match the contract,
 * so a unit test parses this with it.
 */
export function loadNotification(i: { agencyId: string; id: string; sentAt: number; seq: number }) {
  return {
    agencyId: i.agencyId,
    notification: {
      id: i.id,
      type: LOAD_NOTIFICATION_TYPE,
      params: { subject: 'LOAD-S16-01', sentAt: i.sentAt, seq: i.seq },
      link: null,
      actorUserId: null,
      readAt: null,
      createdAt: new Date(i.sentAt).toISOString(),
    },
  };
}

/** What one received `notification` event says: its id and the fan-out latency (null when it is not a load event). */
export function fanoutSample(
  push: unknown,
  receivedAt: number,
): { id: string; sentAt: number; latencyMs: number } | null {
  const n = (push as { notification?: { id?: unknown; params?: { sentAt?: unknown } } } | null)?.notification;
  const sentAt = n?.params?.sentAt;
  if (typeof n?.id !== 'string' || typeof sentAt !== 'number' || !Number.isFinite(sentAt)) return null;
  return { id: n.id, sentAt, latencyMs: receivedAt - sentAt };
}

/** One load-test member and their tokens (the tokens file `tests/load/.data/dashboard-users.json`). */
export interface LoadUser {
  agencyId: string;
  userId: string;
  /** Access token, audience `api`. */
  api: string;
  /** Access token, audience `realtime`. */
  realtime: string;
  /** Position in `users` (the refresh service's key; `pnpm perf:load:tokens`). */
  index?: number;
}

/** The tokens file `pnpm perf:load:tokens` writes (lane A; the realtime smoke writes the same shape). */
export interface LoadUsersFile {
  users: LoadUser[];
  issuedAt: string;
  expiresAt: string;
  /** Its refresh service (`--serve`): `GET <url>/tokens/<index>`, Bearer `secret` → `{ api, realtime, expiresAt }`. */
  refresh?: { url: string; secret: string } | null;
}

/**
 * Sockets per member at most (the server allows 10 per member per node, `CHAT_SOCKET_LIMITS.socketsPerUser`, and a
 * token rotation briefly doubles a member's sockets): a run needs at least sockets ÷ 4 members.
 */
export const MAX_SOCKETS_PER_USER = 4;

export const usersNeeded = (sockets: number) => Math.ceil(sockets / MAX_SOCKETS_PER_USER);

/** The member socket `index` connects as: round robin over the file. */
export const userIndexFor = (index: number, users: number) => index % users;

/** How many of the run's sockets belong to member `j` (round robin): every event to `j` is delivered that often. */
export function socketsOfUser(j: number, sockets: number, users: number): number {
  if (j >= users) return 0;
  return Math.floor(sockets / users) + (j < sockets % users ? 1 : 0);
}

/** The members with at least one socket in this run (the publisher sends only to them). */
export const connectedUsers = (sockets: number, users: number) => Math.min(sockets, users);

/** The JWT's `exp` (seconds) — `decode` is the runtime's base64url decoder (k6: `encoding.b64decode(s, 'rawurl', 's')`). */
export function jwtExpiry(token: string, decode: (b64url: string) => string): number | null {
  const part = token.split('.')[1];
  if (!part) return null;
  const claims = parseJson(decode(part)) as { exp?: unknown } | undefined;
  return typeof claims?.exp === 'number' ? claims.exp : null;
}

/** A token is replaced this long (plus up to the same again, random) before it expires. */
export const ROTATE_LEAD_MS = 60_000;

/**
 * When a socket replaces its token (make-before-break: a new socket with a fresh token, then the old one closes):
 * 60–120 s before `exp`, spread so the rotations of sockets opened together do not all fall in one second. Null
 * when the token outlives the socket's planned close.
 */
export function rotateAt(expSeconds: number, closeAt: number, rng: () => number): number | null {
  const at = expSeconds * 1_000 - ROTATE_LEAD_MS - Math.floor(rng() * ROTATE_LEAD_MS);
  return expSeconds * 1_000 > closeAt ? null : at;
}

/**
 * Whether every member's realtime token lives to the planned close; otherwise the run needs the token refresh service
 * (`pnpm perf:load:tokens --serve`) to rotate. Throws with what to do.
 */
export function assertTokensCover(
  expirySeconds: readonly (number | null)[],
  closeAt: number,
  canRotate: boolean,
): void {
  const bad = expirySeconds.filter((e) => e === null).length;
  if (bad > 0) throw new Error(`${bad} realtime tokens without an exp claim`);
  const earliest = Math.min(...(expirySeconds as number[])) * 1_000;
  if (earliest <= Date.now()) throw new Error('the tokens file has expired: issue it again');
  if (earliest < closeAt && !canRotate) {
    throw new Error(
      `realtime tokens expire ${new Date(earliest).toISOString()}, before the run ends ${new Date(closeAt).toISOString()}: issue them with pnpm perf:load:tokens --serve (token refresh)`,
    );
  }
}

/** Events the publisher owes by `elapsedMs` at `rate` per second, given it has sent `sent` (an open model: no drift). */
export const eventsDue = (elapsedMs: number, rate: number, sent: number) =>
  Math.max(0, Math.floor((elapsedMs * rate) / 1_000) - sent);

/** The recipient of event `seq`: round robin over the connected members (an even load per socket). */
export const recipientOf = (seq: number, connected: number) => seq % connected;

// ---------------------------------------------------------------------------------------------------------------------
// Summary.

interface TrendValues {
  med?: number;
  'p(95)'?: number;
  'p(99)'?: number;
  max?: number;
  count?: number;
  rate?: number;
}
interface SummaryMetric {
  values: TrendValues;
  thresholds?: Record<string, { ok: boolean }>;
}
export interface SummaryData {
  metrics: Record<string, SummaryMetric | undefined>;
}

/** The numbers the STATUS entry and the runbook record, from k6's end-of-test summary (`users`: the file's members). */
export function summaryReport(data: SummaryData, p: Profile, users?: number) {
  const m = data.metrics;
  const ms = (v: number | undefined) => (v === undefined ? null : Math.round(v * 10) / 10);
  const trend = (name: string) => {
    const v = m[name]?.values ?? {};
    return { p50: ms(v.med), p95: ms(v['p(95)']), p99: ms(v['p(99)']), max: ms(v.max) };
  };
  const count = (name: string) => m[name]?.values.count ?? 0;
  const failedThresholds = Object.entries(m).flatMap(([name, metric]) =>
    Object.entries(metric?.thresholds ?? {})
      .filter(([, t]) => !t.ok)
      .map(([expr]) => `${name} ${expr}`),
  );
  return {
    target: { sockets: p.sockets, seconds: p.seconds, eventRate: p.eventRate, p95Ms: p.p95Ms },
    connect: trend(METRICS.connect),
    connectOkRate: m[METRICS.connectOk]?.values.rate ?? null,
    fanout: trend(`${METRICS.fanout}${STEADY}`),
    received: count(`${METRICS.received}${STEADY}`),
    expectedDeliveries: users === undefined ? null : Math.round(expectedSteadyDeliveries(p, users)),
    receivedAll: count(METRICS.received),
    duplicates: count(METRICS.duplicates),
    unexpectedDisconnects: count(METRICS.unexpected),
    rotations: count(METRICS.rotations),
    negativeLatency: count(METRICS.negative),
    failedThresholds,
    pass: failedThresholds.length === 0,
  };
}

/** The summary as text (k6 `handleSummary` stdout). */
export function summaryText(data: SummaryData, p: Profile, users?: number): string {
  const r = summaryReport(data, p, users);
  const n = (v: number | null) => (v === null ? '     -' : v.toFixed(1).padStart(7));
  const a = PROFILES[ACCEPTANCE_PROFILE];
  const acceptance =
    p.sockets === a.sockets && p.seconds === a.seconds && p.eventRate === a.eventRate && p.p95Ms === a.p95Ms;
  const lines = [
    `realtime load test — ${r.target.sockets} sockets, ${r.target.eventRate} notifications/s for ${r.target.seconds} s${acceptance ? ' (the acceptance profile)' : ' — NOT the acceptance profile'}`,
    `  connects ok ${r.connectOkRate === null ? '-' : `${(r.connectOkRate * 100).toFixed(2)} %`}; unexpected disconnects ${r.unexpectedDisconnects}; token rotations ${r.rotations}`,
    `  received ${r.received}${r.expectedDeliveries === null ? '' : ` of ${r.expectedDeliveries} expected`} notifications sent in the steady phase (${r.receivedAll} in all); duplicates ${r.duplicates}; negative latencies ${r.negativeLatency}`,
    '  ms                     p50      p95      p99      max',
    `  connect           ${n(r.connect.p50)}  ${n(r.connect.p95)}  ${n(r.connect.p99)}  ${n(r.connect.max)}`,
    `  fan-out (steady)  ${n(r.fanout.p50)}  ${n(r.fanout.p95)}  ${n(r.fanout.p99)}  ${n(r.fanout.max)}`,
    r.pass ? '  PASS: every threshold held' : `  FAIL: ${r.failedThresholds.join('; ')}`,
  ];
  return `${lines.join('\n')}\n`;
}
