// pnpm perf:load:tokens [--test | --staging] [--users 5000] [--out file] [--serve [--host 127.0.0.1] [--port 4790] [--public-url URL]]
//
// Dashboard and realtime load tests (S16-01): picks --users scale-seed members (agents, spread over the verified
// agencies: one per agency first, then a second…) and writes the users file the k6 scripts read (secrets: default
// `tests/load/.data/dashboard-users.json`, git-ignored):
//
//   { "users": [{ agencyId, userId, api, realtime, index, office }], "issuedAt", "expiresAt", "refresh": { url, secret } | null }
//
// `api` / `realtime` are 15-minute access tokens (audiences `api` / `realtime`) minted by `identity.issueAccessToken` —
// the service behind the web app's `GET /session/token`, so membership, account status and session version are checked
// exactly as for a signed-in member. Agents only: admins must pass the second factor first, which a script cannot.
//
// Token refresh (runs longer than ~12 minutes): `--serve` keeps the process up as a small refresh service —
// `GET /tokens/<index>` with `Authorization: Bearer <refresh.secret>` answers `{ api, realtime, expiresAt }`, minting
// again (the same service call) once fewer than 5 minutes are left. k6 calls it per VU before its token expires
// (`refresh.url`, or `TOKENS_REFRESH_URL`). Why not the web app's own refresh: that is `GET /session/token` behind an
// Auth.js session cookie, and getting one takes the browser sign-in flow (CSRF form, credentials, a login rate limit per
// IP and account) for 5,000 accounts — and the web app on the load path, which is not what this test measures. The
// service mints for the members of this file only (by index), behind a random per-run secret (constant-time compare),
// at most MINT_CONCURRENCY mints at once, binds to 127.0.0.1 unless --host says otherwise — a non-loopback --host only
// with an `https:` --public-url (a TLS proxy in front: the secret and tokens never cross the network in clear) — and
// never runs against production (`assertLoadTarget`). Runbook: docs/runbooks/load-suite.md › Dashboard.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { authCtx } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import { closeDb, configureDb, dbEnv, withSystem } from '@inmolink/db';
import { authSignEnv, cryptoEnv, loadConfigOrExit, rateLimitEnv } from '@inmolink/platform/config';
import { newId } from '@inmolink/platform/ids';
import { createAccessTokenSigner, privateKeyFromBase64 } from '@inmolink/platform/jwt';
import { createLogger, type Logger } from '@inmolink/platform/logger';
import { closeRateLimit, configureRateLimit } from '@inmolink/platform/rate-limit';
import { sql } from 'drizzle-orm';
import { officeAddress } from '../../tests/load/lib/dashboard-mix';
import { readStackEnv } from '../ops/stack-env';
import { assertLoadTarget, SCALE_EMAIL_LIKE } from './load-sites';

const ROOT = join(import.meta.dirname, '..', '..');
export const DEFAULT_USERS_FILE = join(ROOT, 'tests', 'load', '.data', 'dashboard-users.json');
/** Re-mint when fewer than this many seconds are left (k6 asks 2–3 minutes before expiry). */
export const REMINT_BELOW_SECONDS = 5 * 60;
const REASON = 'perf.load-tokens';
/** Mints in flight at once (each one short `app_auth` transaction). */
const MINT_CONCURRENCY = 16;

/** A member the load test acts as (internal: the session version the mint checks). */
export interface LoadMember {
  agencyId: string;
  userId: string;
  sessionVersion: number;
  /** Ordinal of the member's agency in the pick (its office address). */
  agencyOrdinal: number;
}

/** One entry of the users file (lane B, the realtime test, reads the same file). */
export interface LoadUser {
  agencyId: string;
  userId: string;
  /** Bearer access token, audience `api`. */
  api: string;
  /** Access token, audience `realtime`. */
  realtime: string;
  /** Position in `users` (the refresh service's key). */
  index: number;
  /** The office address the member's requests come from (`X-Forwarded-For`; one per agency). */
  office: string;
}

export interface LoadUsersFile {
  users: LoadUser[];
  issuedAt: string;
  /** The earliest expiry of any token in the file. */
  expiresAt: string;
  /** The refresh service (`--serve`), or null: the tokens last one lifetime. */
  refresh: { url: string; secret: string } | null;
  /**
   * S16-F4: the span every member's agency has seeded calendar events in (the latest first start, the earliest last
   * one, ISO), or null without one: the dashboard's calendar action asks for a week inside it (`calendarWeekStart`).
   */
  calendarWindow?: { from: string; to: string } | null;
}

/**
 * `n` active scale-seed agents (`AGENT` / `DEVELOPER_AGENT`, never an admin) of verified agencies, spread: the first
 * agent of every agency, then the second… One statement.
 */
export async function pickLoadMembers(n: number, emailLike = SCALE_EMAIL_LIKE): Promise<LoadMember[]> {
  return withSystem(`${REASON}.members`, async (tx) => {
    const rows = await tx.execute<{ agency_id: string; user_id: string; session_version: number; ord: number }>(sql`
      select m.agency_id, m.user_id, u.session_version, dense_rank() over (order by m.agency_id)::int as ord
        from (select agency_id, user_id,
                     row_number() over (partition by agency_id order by email) as rn
                from agency_members
               where role in ('AGENT', 'DEVELOPER_AGENT') and deactivated_at is null and email like ${emailLike}) m
        join agencies a on a.agency_id = m.agency_id and a.status = 'VERIFIED'
        join users u on u.id = m.user_id and u.status = 'ACTIVE'
       order by m.rn, m.agency_id
       limit ${n}`);
    return rows.rows.map((r) => ({
      agencyId: r.agency_id,
      userId: r.user_id,
      sessionVersion: Number(r.session_version),
      agencyOrdinal: Number(r.ord),
    }));
  });
}

/** Both tokens of one member, through the service behind `GET /session/token` (no second factor: agents only). */
export async function mintMember(m: LoadMember): Promise<{ api: string; realtime: string; expiresAt: Date }> {
  const mint = (audience: 'api' | 'realtime') =>
    identity.issueAccessToken(authCtx(newId()), {
      userId: m.userId,
      sessionVersion: m.sessionVersion,
      mfaVerified: false,
      audience,
    });
  const [api, realtime] = [await mint('api'), await mint('realtime')];
  const expiresAt = new Date(Math.min(Date.parse(api.expiresAt), Date.parse(realtime.expiresAt)));
  return { api: api.token, realtime: realtime.token, expiresAt };
}

/** A semaphore: `run(fn)` starts `fn` once fewer than `limit` runs are in flight (FIFO). */
export function createLimiter(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** Whether `host` is a loopback bind address (`localhost`, 127.0.0.0/8, ::1). */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  return isIP(h) === 4 && h.startsWith('127.');
}

/**
 * The refresh service hands out bearer tokens: off loopback it is reachable only behind a TLS proxy (`--public-url
 * https://…`). `dockerLocal`: the local smoke, whose k6 container reaches the host through Docker's gateway — only for
 * a local target (`assertLoadTarget` without --staging).
 */
export function assertRefreshExposure(host: string, publicUrl: string | undefined, dockerLocal = false): void {
  if (isLoopbackHost(host) || dockerLocal) return;
  let protocol: string | undefined;
  try {
    protocol = publicUrl === undefined ? undefined : new URL(publicUrl).protocol;
  } catch {
    protocol = undefined;
  }
  if (protocol !== 'https:') {
    throw new Error(
      `--host ${host} is not loopback: put a TLS proxy in front and pass its https: --public-url (tokens and the refresh secret must not cross the network in clear)`,
    );
  }
}

/** `fn` over `xs`, `limit` at a time, results in order. */
async function mapLimit<T, R>(xs: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, xs.length) }, async () => {
      for (let i = next++; i < xs.length; i = next++) out[i] = await fn(xs[i] as T);
    }),
  );
  return out;
}

/** The users file for `members` (tokens minted now); `refresh` from a running service, if any. */
export async function mintUsersFile(
  members: readonly LoadMember[],
  refresh: LoadUsersFile['refresh'] = null,
): Promise<LoadUsersFile> {
  const issuedAt = new Date();
  const minted = await mapLimit(members, MINT_CONCURRENCY, mintMember);
  const users = members.map((m, index) => {
    const t = minted[index] as Awaited<ReturnType<typeof mintMember>>;
    return {
      agencyId: m.agencyId,
      userId: m.userId,
      api: t.api,
      realtime: t.realtime,
      index,
      office: officeAddress(m.agencyOrdinal),
    };
  });
  const expiresAt = new Date(Math.min(...minted.map((t) => t.expiresAt.getTime())));
  const calendarWindow = await seededCalendarWindow([...new Set(members.map((m) => m.agencyId))]);
  return { users, issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString(), refresh, calendarWindow };
}

/**
 * S16-F4: the span every one of `agencyIds` with calendar events has events in — the latest of their first starts to
 * the earliest of their last — or null (none, or no common span). Index-only per agency
 * (`calendar_events_agency_idx`: agency_id, starts_at). One statement.
 */
export async function seededCalendarWindow(agencyIds: readonly string[]): Promise<{ from: string; to: string } | null> {
  if (agencyIds.length === 0) return null;
  const [row] = await withSystem(
    `${REASON}.calendar`,
    async (tx) =>
      (
        await tx.execute<{ lo: string | null; hi: string | null }>(sql`
        select max(x.lo) as lo, min(x.hi) as hi
          from unnest(${`{${agencyIds.join(',')}}`}::uuid[]) as a(id)
          cross join lateral (select min(starts_at) as lo, max(starts_at) as hi
                                from calendar_events e where e.agency_id = a.id) x
         where x.lo is not null`)
      ).rows,
  );
  if (!row?.lo || !row.hi) return null;
  const from = new Date(row.lo);
  const to = new Date(row.hi);
  return from < to ? { from: from.toISOString(), to: to.toISOString() } : null;
}

export interface TokenService {
  /** The URL it listens on (`http://<host>:<port>`). */
  url: string;
  secret: string;
  /** Tokens minted again so far. */
  remints(): number;
  close(): Promise<void>;
}

/**
 * The refresh service: `GET /tokens/<index>` (Bearer `secret`) → `{ api, realtime, expiresAt }` for member `index` of
 * `members`, re-minted when fewer than `REMINT_BELOW_SECONDS` are left (one mint in flight per member). Anything else:
 * 401 / 404. `initial`: the tokens of the users file, served until they are due.
 */
export async function startTokenService(opts: {
  members: readonly LoadMember[];
  initial?: LoadUsersFile;
  host?: string;
  port?: number;
  /** The URL k6 reaches the service at (`--public-url`): must be `https:` when `host` is not loopback. */
  publicUrl?: string;
  /** Local smoke only: bind off loopback for k6 in a container (see `assertRefreshExposure`). */
  dockerLocal?: boolean;
  secret?: string;
  log?: Logger;
  /** Mints in flight at once (default MINT_CONCURRENCY). */
  concurrency?: number;
  /** Mints one member's tokens (default `mintMember`; tests pass their own). */
  mint?: (m: LoadMember) => Promise<{ api: string; realtime: string; expiresAt: Date }>;
}): Promise<TokenService> {
  const host = opts.host ?? '127.0.0.1';
  assertRefreshExposure(host, opts.publicUrl, opts.dockerLocal);
  const mint = opts.mint ?? mintMember;
  // Every k6 VU asks within the same few minutes before expiry: refresh mints queue here, not on the auth pool.
  const limit = createLimiter(opts.concurrency ?? MINT_CONCURRENCY);
  const secret = opts.secret ?? randomBytes(32).toString('base64url');
  const expected = Buffer.from(`Bearer ${secret}`);
  type Held = { api: string; realtime: string; expiresAt: Date };
  const held = new Map<number, Held>();
  const inFlight = new Map<number, Promise<Held>>();
  let remints = 0;
  if (opts.initial) {
    const expiresAt = new Date(opts.initial.expiresAt);
    for (const u of opts.initial.users) held.set(u.index, { api: u.api, realtime: u.realtime, expiresAt });
  }
  const tokensOf = async (index: number): Promise<Held> => {
    const h = held.get(index);
    if (h && h.expiresAt.getTime() - Date.now() > REMINT_BELOW_SECONDS * 1_000) return h;
    const running = inFlight.get(index);
    if (running) return running;
    const p = limit(() => mint(opts.members[index] as LoadMember))
      .then((t) => {
        held.set(index, t);
        remints++;
        return t;
      })
      .finally(() => inFlight.delete(index));
    inFlight.set(index, p);
    return p;
  };
  const authorized = (header: string | undefined) => {
    const got = Buffer.from(header ?? '');
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const m = /^\/tokens\/(\d{1,7})$/.exec(req.url ?? '');
    if (req.method !== 'GET' || !m) return send(404, { error: 'NOT_FOUND' });
    if (!authorized(req.headers.authorization)) return send(401, { error: 'NOT_AUTHENTICATED' });
    const index = Number(m[1]);
    if (index >= opts.members.length) return send(404, { error: 'NOT_FOUND' });
    tokensOf(index).then(
      (t) => send(200, { api: t.api, realtime: t.realtime, expiresAt: t.expiresAt.toISOString() }),
      (err: unknown) => {
        opts.log?.warn({ err, index }, 'load-tokens: mint failed');
        send(503, { error: 'MINT_FAILED' });
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const { port } = server.address() as { port: number };
  return {
    url: `http://${host}:${port}`,
    secret,
    remints: () => remints,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Identity with the access-token signer (the web app's key of this environment) and the limits Redis it reads. */
export async function configureTokenMinting(
  env: { AUTH_JWT_PRIVATE_KEY: string; AUTH_JWT_KEY_ID: string; HMAC_KEY: string; REDIS_LIMITS_URL: string },
  log: Logger,
): Promise<void> {
  // Client Mode state lives in the limits Redis: read at every mint (never set for load-test members).
  await configureRateLimit({ url: env.REDIS_LIMITS_URL, logger: log });
  identity.configureIdentity({
    hmacKey: env.HMAC_KEY,
    signer: createAccessTokenSigner({
      privateKey: privateKeyFromBase64(env.AUTH_JWT_PRIVATE_KEY),
      keyId: env.AUTH_JWT_KEY_ID,
    }),
  });
}

/** Writes the users file (secrets: mode 600). */
export function writeUsersFile(path: string, file: LoadUsersFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file), { mode: 0o600 });
  // `mode` applies only when the file is created: one left by an earlier run keeps its mode without this.
  chmodSync(path, 0o600);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      test: { type: 'boolean', default: false },
      staging: { type: 'boolean', default: false },
      users: { type: 'string', default: '5000' },
      out: { type: 'string', default: DEFAULT_USERS_FILE },
      serve: { type: 'boolean', default: false },
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '4790' },
      'public-url': { type: 'string' },
    },
  });
  // Locally, read the stack's env file (dev or --test) unless real credentials are already set.
  if (process.env.NODE_ENV !== 'production' && !Object.keys(process.env).some((k) => k.startsWith('DATABASE_URL_'))) {
    for (const [k, v] of Object.entries(readStackEnv(values.test ? 'test' : 'dev'))) process.env[k] ??= v;
  }
  process.env.APP_ROLE = 'script';
  const log = createLogger({ service: 'perf:load-tokens', level: process.env.LOG_LEVEL ?? 'info' });
  let service: TokenService | undefined;
  try {
    assertLoadTarget(process.env, values.staging);
    const users = Number(values.users);
    if (!Number.isInteger(users) || users < 1) throw new TypeError('--users must be a positive integer');
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError('--port must be a port number');
    // Before minting 5,000 tokens: an exposed service without TLS is refused (startTokenService checks again).
    if (values.serve) assertRefreshExposure(values.host, values['public-url']);
    const config = loadConfigOrExit({ ...dbEnv, ...authSignEnv, ...rateLimitEnv, HMAC_KEY: cryptoEnv.HMAC_KEY });
    await configureDb(config, { logger: log });
    await configureTokenMinting(config, log);
    const members = await pickLoadMembers(users);
    if (members.length < users) {
      throw new Error(`${members.length} active scale-seed agents in verified agencies; ${users} needed (seed more)`);
    }
    const file = await mintUsersFile(members);
    if (values.serve) {
      service = await startTokenService({
        members,
        initial: file,
        host: values.host,
        port,
        publicUrl: values['public-url'],
        log,
      });
      file.refresh = { url: values['public-url'] ?? service.url, secret: service.secret };
    }
    writeUsersFile(values.out, file);
    log.info(
      { users: file.users.length, agencies: new Set(members.map((m) => m.agencyId)).size, out: values.out },
      'load-test users written',
    );
    if (service) {
      const s = service;
      log.info({ url: s.url, public: file.refresh?.url }, 'token refresh service up (Ctrl+C stops it)');
      await new Promise<void>((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
      log.info({ remints: s.remints() }, 'token refresh service stopping');
    }
  } catch (err) {
    log.error({ err }, 'load-test users failed');
    process.exitCode = 1;
  } finally {
    await service?.close();
    await closeRateLimit();
    await closeDb();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
