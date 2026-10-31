import { NotificationPush, REALTIME_NOTIFICATION_EVENT, REALTIME_NOTIFICATIONS_NAMESPACE } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import {
  assertTokensCover,
  connectAt,
  connectedUsers,
  decodeFrame,
  EVENT,
  encodeConnect,
  encodeDisconnect,
  encodeEvent,
  eventsDue,
  expectedSteadyDeliveries,
  fanoutSample,
  jwtExpiry,
  loadNotification,
  MAX_SOCKETS_PER_USER,
  METRICS,
  minSteadyDeliveries,
  NAMESPACE,
  PONG,
  PROFILES,
  phaseOf,
  ROTATE_LEAD_MS,
  recipientOf,
  resolveProfile,
  resolveStartAt,
  rotateAt,
  SLO,
  type SummaryData,
  scenarios,
  socketsOfUser,
  socketUrl,
  summaryReport,
  summaryText,
  thresholds,
  timeline,
  userIndexFor,
  usersNeeded,
} from './lib/realtime-mix';

const AGENCY = '0195f0a5-0001-7000-8000-000000000001';
const ID = '0195f0a5-0009-7000-8000-000000000001';
const b64url = (s: string) => Buffer.from(s, 'base64url').toString('utf8');
const jwtWith = (claims: object) =>
  `${Buffer.from('{"alg":"EdDSA"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

describe('realtime load test (S16-01)', () => {
  it('[S16-01] staging profile is the PLAN §15 target: 5,000 sockets for 15 min, fan-out p95 < 500 ms; no overrides', () => {
    const p = resolveProfile({ PROFILE: 'staging' });
    expect(p).toMatchObject({ sockets: 5_000, seconds: 900, p95Ms: 500, connectSuccess: 0.999 });
    expect(p.warmupSeconds).toBeGreaterThanOrEqual(p.rampSeconds);
    for (const k of ['SOCKETS', 'DURATION', 'WARMUP', 'RAMP', 'EVENT_RATE', 'P95_MS']) {
      expect(() => resolveProfile({ PROFILE: 'staging', [k]: '10' })).toThrow(/acceptance check/);
    }
    expect(() => resolveProfile({ PROFILE: 'soak', SOCKETS: '10' })).toThrow(/acceptance check/);
    expect(() => resolveProfile({ PROFILE: 'nope' })).toThrow(/PROFILE must be/);
  });

  it('[S16-01] soak profile: 2,500 sockets (50 % load) for 24 h; smoke is small, short and overridable', () => {
    expect(resolveProfile({ PROFILE: 'soak' })).toMatchObject({ sockets: SLO.sockets / 2, seconds: 24 * 3_600 });
    const s = resolveProfile({});
    expect(s.name).toBe('smoke');
    expect(s.sockets).toBeLessThanOrEqual(100);
    expect(s.seconds).toBeLessThanOrEqual(120);
    const o = resolveProfile({ SOCKETS: '8', DURATION: '20', WARMUP: '1', RAMP: '4', EVENT_RATE: '5' });
    expect(o).toMatchObject({ sockets: 8, seconds: 20, rampSeconds: 4, eventRate: 5 });
    expect(o.warmupSeconds).toBe(4); // never shorter than the ramp
    expect(() => resolveProfile({ SOCKETS: '-1' })).toThrow(/positive/);
  });

  it('[S16-01] thresholds encode the acceptance check: steady fan-out p95, connects > 99.9 %, no unexpected disconnect', () => {
    const t = thresholds(PROFILES.staging, 1_250);
    expect(t[`${METRICS.fanout}{phase:steady}`]).toEqual(['p(95)<500']);
    // 500 events/s × 900 s, 4 sockets per member: 1.8 M deliveries owed, 99.9 % of them must arrive
    expect(t[`${METRICS.received}{phase:steady}`]).toEqual(['count>=1798200']);
    expect(t[METRICS.connectOk]).toEqual(['rate>0.999']);
    expect(t[METRICS.unexpected]).toEqual(['count<1']);
    const sc = scenarios(PROFILES.staging, 30).sockets as Record<string, unknown>;
    expect(sc).toMatchObject({ executor: 'per-vu-iterations', exec: 'holdSocket', vus: 5_000, iterations: 1 });
    // held through warm-up, steady and tail, plus the shared start delay
    expect(Number.parseInt(String(sc.maxDuration), 10)).toBeGreaterThan(30 + 150 + 900 + 10);
  });

  it('[S16-01] delivery threshold: k6 derives the steady deliveries the publisher owes and needs ≥ 99.9 % of them', () => {
    expect(SLO.deliveredShare).toBe(0.999);
    // one socket per member (more members than sockets): one delivery per event
    expect(expectedSteadyDeliveries({ ...PROFILES.smoke, sockets: 10, eventRate: 5, seconds: 60 }, 40)).toBe(300);
    // 50 sockets over 13 members (round robin 4,4,…,3): each round of 13 events delivers 50
    const smoke = PROFILES.smoke;
    expect(expectedSteadyDeliveries(smoke, 13)).toBeCloseTo((20 * 60 * 50) / 13, 6);
    expect(minSteadyDeliveries(smoke, 13)).toBe(Math.ceil(0.999 * ((20 * 60 * 50) / 13)));
    expect(thresholds(smoke, 13)[`${METRICS.received}{phase:steady}`]).toEqual([
      `count>=${minSteadyDeliveries(smoke, 13)}`,
    ]);
    // A run with no member left still judges that something arrived.
    expect(thresholds(smoke, 0)[`${METRICS.received}{phase:steady}`]).toEqual(['count>=1']);

    // The publisher's own pacing (20 ms ticks, open model, round robin) over the steady phase lands within the 0.1 %
    // slack of the derivation — so a run where everything arrives passes and one that drops 0.2 % fails.
    for (const [p, users] of [
      [smoke, 13],
      [PROFILES.staging, 1_250],
    ] as const) {
      const startAt = 1_000_000;
      const tl = timeline(p, startAt);
      let seq = 0;
      let deliveries = 0;
      for (let now = startAt; now < tl.steadyUntil; now += 20) {
        const due = eventsDue(now - startAt, p.eventRate, seq);
        if (phaseOf(now, tl) === 'steady') {
          for (let k = 0; k < due; k++) {
            deliveries += socketsOfUser(recipientOf(seq + k, connectedUsers(p.sockets, users)), p.sockets, users);
          }
        }
        seq += due;
      }
      expect(deliveries).toBeGreaterThanOrEqual(minSteadyDeliveries(p, users));
      expect(Math.floor(deliveries * 0.998)).toBeLessThan(minSteadyDeliveries(p, users));
    }
  });

  it('[S16-01] START_AT: required for staging and soak (k6 and the publisher share one clock); smoke defaults', () => {
    for (const name of ['staging', 'soak'] as const) {
      expect(() => resolveStartAt(name, undefined, 5)).toThrow(/needs START_AT/);
      expect(() => resolveStartAt(name, '', 5)).toThrow(/needs START_AT/);
      expect(resolveStartAt(name, '1800000000000', 5)).toBe(1_800_000_000_000);
    }
    expect(resolveStartAt('smoke', undefined, 5)).toBe(5);
    expect(() => resolveStartAt('smoke', 'soon', 5)).toThrow(/ms epoch/);
  });

  it('[S16-01] timeline: sockets open evenly over the ramp; events are judged by the phase they were sent in', () => {
    const p = PROFILES.smoke;
    const tl = timeline(p, 1_000_000);
    expect(tl.steadyFrom).toBe(1_000_000 + p.warmupSeconds * 1_000);
    expect(tl.steadyUntil - tl.steadyFrom).toBe(p.seconds * 1_000);
    expect(tl.closeAt - tl.steadyUntil).toBe(p.tailSeconds * 1_000);
    expect(connectAt(0, p, 1_000_000)).toBe(1_000_000);
    const last = connectAt(p.sockets - 1, p, 1_000_000);
    expect(last).toBeLessThan(1_000_000 + p.rampSeconds * 1_000);
    expect(last).toBeLessThan(tl.steadyFrom); // every socket open before it is judged
    expect(phaseOf(tl.steadyFrom - 1, tl)).toBe('warmup');
    expect(phaseOf(tl.steadyFrom, tl)).toBe('steady');
    expect(phaseOf(tl.steadyUntil, tl)).toBe('tail');
  });

  it('[S16-01] Socket.io v4 framing: namespace connect with auth, ping → pong, events, connect errors, disconnects', () => {
    expect(socketUrl('https://rt.example/')).toBe('wss://rt.example/socket.io/?EIO=4&transport=websocket');
    expect(socketUrl('http://127.0.0.1:4002')).toBe('ws://127.0.0.1:4002/socket.io/?EIO=4&transport=websocket');
    expect(encodeConnect('/notifications', { token: 'abc' })).toBe('40/notifications,{"token":"abc"}');
    expect(encodeConnect('/')).toBe('40');
    expect(encodeDisconnect('/notifications')).toBe('41/notifications,');
    expect(encodeEvent('/chat', 'join', { threadId: 't' })).toBe('42/chat,["join",{"threadId":"t"}]');
    expect(PONG).toBe('3');

    expect(
      decodeFrame('0{"sid":"s1","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}'),
    ).toEqual({ kind: 'open', sid: 's1', pingInterval: 25_000, pingTimeout: 20_000, maxPayload: 1_000_000 });
    expect(decodeFrame('2')).toEqual({ kind: 'ping' });
    expect(decodeFrame('1')).toEqual({ kind: 'close' });
    expect(decodeFrame('40/notifications,{"sid":"x"}')).toEqual({ kind: 'connect', nsp: '/notifications', sid: 'x' });
    expect(decodeFrame('44/notifications,{"message":"NOT_AUTHENTICATED"}')).toEqual({
      kind: 'connect_error',
      nsp: '/notifications',
      message: 'NOT_AUTHENTICATED',
    });
    expect(decodeFrame('41/notifications,')).toEqual({ kind: 'disconnect', nsp: '/notifications' });
    expect(decodeFrame('42/notifications,["notification",{"a":1}]')).toEqual({
      kind: 'event',
      nsp: '/notifications',
      event: 'notification',
      args: [{ a: 1 }],
      ackId: null,
    });
    expect(decodeFrame('42/chat,7["typing",{}]')).toMatchObject({ kind: 'event', nsp: '/chat', ackId: 7 });
    expect(decodeFrame('42["hello"]')).toMatchObject({ kind: 'event', nsp: '/', event: 'hello' });
    expect(decodeFrame('43/chat,7[{"ok":true}]')).toEqual({
      kind: 'ack',
      nsp: '/chat',
      ackId: 7,
      args: [{ ok: true }],
    });
    // binary packets, garbage and unknown types are reported, never thrown
    expect(decodeFrame('451-/n,["x",{"_placeholder":true,"num":0}]').kind).toBe('unknown');
    expect(decodeFrame('42/notifications,{not json').kind).toBe('unknown');
    expect(decodeFrame('9').kind).toBe('unknown');
    expect(decodeFrame('').kind).toBe('unknown');
  });

  it('[S16-01] namespace and event match the contracts; the publisher payload is a valid NotificationPush', () => {
    expect(NAMESPACE).toBe(REALTIME_NOTIFICATIONS_NAMESPACE);
    expect(EVENT).toBe(REALTIME_NOTIFICATION_EVENT);
    const sentAt = Date.UTC(2026, 10, 1, 12);
    const push = loadNotification({ agencyId: AGENCY, id: ID, sentAt, seq: 42 });
    expect(NotificationPush.safeParse(push).success).toBe(true);
    expect(fanoutSample(push, sentAt + 37)).toEqual({ id: ID, sentAt, latencyMs: 37 });
    // anything that is not a load-test notification is ignored
    expect(fanoutSample({ notification: { id: ID, params: {} } }, sentAt)).toBeNull();
    expect(fanoutSample(null, sentAt)).toBeNull();
  });

  it('[S16-01] members: ≤ 4 sockets each (server cap 10, rotation doubles), round robin; deliveries per event', () => {
    expect(MAX_SOCKETS_PER_USER).toBeLessThanOrEqual(10 / 2);
    expect(usersNeeded(5_000)).toBe(1_250);
    expect(userIndexFor(7, 5)).toBe(2);
    // 7 sockets over 3 members: 3, 2, 2 — and every socket counted once
    expect([0, 1, 2].map((j) => socketsOfUser(j, 7, 3))).toEqual([3, 2, 2]);
    expect(socketsOfUser(5, 3, 10)).toBe(0); // members past the sockets have none
    expect(connectedUsers(3, 10)).toBe(3);
    expect(connectedUsers(30, 10)).toBe(10);
    expect(recipientOf(11, 4)).toBe(3);
  });

  it('[S16-01] publisher pacing is open-model: what is owed by the clock, whatever a slow tick left', () => {
    expect(eventsDue(0, 500, 0)).toBe(0);
    expect(eventsDue(1_000, 500, 0)).toBe(500);
    expect(eventsDue(1_020, 500, 500)).toBe(10);
    expect(eventsDue(1_000, 500, 600)).toBe(0); // never negative
  });

  it('[S16-01] tokens: rotation 60–120 s before exp; a run outliving its tokens needs a token source', () => {
    expect(jwtExpiry(jwtWith({ exp: 1_800_000_000 }), b64url)).toBe(1_800_000_000);
    expect(jwtExpiry('nope', b64url)).toBeNull();
    const exp = 2_000_000_000;
    expect(rotateAt(exp, exp * 1_000 - 1, () => 0)).toBeNull(); // the token outlives the socket
    expect(rotateAt(exp, exp * 1_000 + 60_000, () => 0)).toBe(exp * 1_000 - ROTATE_LEAD_MS);
    expect(rotateAt(exp, exp * 1_000 + 60_000, () => 0.999)).toBeGreaterThan(exp * 1_000 - 2 * ROTATE_LEAD_MS);
    const soon = Math.floor(Date.now() / 1_000) + 900;
    expect(() => assertTokensCover([soon], Date.now() + 60_000, false)).not.toThrow();
    expect(() => assertTokensCover([soon], Date.now() + 3_600_000, false)).toThrow(/--serve/);
    expect(() => assertTokensCover([soon], Date.now() + 3_600_000, true)).not.toThrow();
    expect(() => assertTokensCover([Math.floor(Date.now() / 1_000) - 1], Date.now(), true)).toThrow(/expired/);
    expect(() => assertTokensCover([null], Date.now(), true)).toThrow(/exp claim/);
  });

  it('[S16-01] summary: connect and fan-out percentiles, disconnects, PASS / FAIL, acceptance label', () => {
    const data: SummaryData = {
      metrics: {
        [METRICS.connect]: { values: { med: 12.3, 'p(95)': 40.04, 'p(99)': 80, max: 120 } },
        [METRICS.connectOk]: { values: { rate: 1 }, thresholds: { 'rate>0.999': { ok: true } } },
        [`${METRICS.fanout}{phase:steady}`]: {
          values: { med: 8, 'p(95)': 612, 'p(99)': 700, max: 900 },
          thresholds: { 'p(95)<500': { ok: false } },
        },
        [`${METRICS.received}{phase:steady}`]: { values: { count: 1_200 } },
        [METRICS.received]: { values: { count: 1_500 } },
        [METRICS.unexpected]: { values: { count: 0 } },
        [METRICS.rotations]: { values: { count: 3 } },
      },
    };
    const r = summaryReport(data, PROFILES.smoke, 13);
    expect(r).toMatchObject({
      connectOkRate: 1,
      received: 1_200,
      receivedAll: 1_500,
      unexpectedDisconnects: 0,
      rotations: 3,
      expectedDeliveries: Math.round((20 * 60 * 50) / 13),
      pass: false,
      failedThresholds: [`${METRICS.fanout}{phase:steady} p(95)<500`],
    });
    expect(r.connect.p95).toBe(40);
    expect(r.fanout).toEqual({ p50: 8, p95: 612, p99: 700, max: 900 });
    expect(summaryReport(data, PROFILES.smoke).expectedDeliveries).toBeNull();
    const text = summaryText(data, PROFILES.smoke, 13);
    expect(text).toContain(`received 1200 of ${Math.round((20 * 60 * 50) / 13)} expected`);
    expect(text).toMatch(/NOT the acceptance profile/);
    expect(text).toMatch(/FAIL/);
    expect(summaryText({ metrics: {} }, PROFILES.staging)).toMatch(/\(the acceptance profile\)[\s\S]*PASS/);
  });
});
