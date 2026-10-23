/**
 * The push engine (S9-04, PLAN §3 #19, §7 M7): one run sends an agency's push-portal connections (idealista, Fotocasa)
 * what changed since the last run, or takes their adverts down. Worker-only (imported through `../worker`): it reads
 * every agency's tables as `app_system`.
 *
 * Per connection, sequentially (one run per agency at a time: the job has its own group per agency, `<agency>:push`,
 * so its portal calls never hold the lease the agency's feed passes wait on, and shares the pool's heavy-job caps with
 * them, S9 review). A connection is in one of two **modes**:
 *
 * - **SYNC** (enabled, its flag on, the agency verified):
 *   1. *Selection and validation are the feeds'*: rounds of `selectConnectionListings` (S9-01), documents read once per
 *      round (`ownListingDetails`), `validateItem` against the adapter's profile (S9-02), the failures stored as the
 *      connection's issues. A listing that fails validation is not sent; if the portal already holds it, it stays as
 *      it is (taking an advert down for a missing photo seemed worse than a stale one; the issue is shown).
 *   2. *Change detection*: the listing is mapped to the portal's payload (pure) and hashed; `portal_listing_sync` holds
 *      the hash last sent (or refused) per listing. Same hash: nothing to send. New or changed: publish / update. An
 *      advert (a row with a remote id, not WITHDRAWN) whose listing the selection did not return for the round's id
 *      range - deselected, no longer public, deleted - is withdrawn, whatever its state (a FAILED row can still have
 *      an advert up). The ranges are the selection's own, so there is no sweep over the table.
 * - **TEARDOWN** (the connection is off, its flag is off, or the agency is suspended / unverified): every advert still
 *   up is withdrawn, while the credentials are still readable. Nothing is selected or validated. A connection cannot
 *   be deleted while it has adverts up (`deleteConnection`): turn it off, wait for this, then delete.
 *
 * Both modes: **calls happen outside any transaction** (CLAUDE.md rule 6), with credentials decrypted here in the
 * worker and held in memory; every call is idempotent on the portal (adverts are keyed by our reference), and the
 * results of a round are written to the sync table even when a later call throws, so a retry does not resend them.
 *
 * **Errors** (`PortalPushError`): a refused listing is recorded FAILED with the code and not sent again until its
 * content changes (a refused withdrawal: FAILED with `WITHDRAW_REJECTED`, not asked again). A connection-level failure
 * stops the connection: a retryable one with a `Retry-After` is handed to a continuation after that wait, one without
 * makes the job retry (exponential backoff); a permanent one (`AUTH_REJECTED`, `CREDENTIALS_MISSING`, a wrong base
 * URL) is stored on the connection (`push_error`) and skipped until its credentials or on/off state change (the
 * nightly run tries again), so the token endpoint is not hit on every event.
 *
 * **Bounded**: the whole run (all connections) has one deadline (`runBudgetMs`, under the job's timeout) and each
 * connection at most `maxCallsPerRun` calls; the rest is `more`, with the selection round to resume at (`resume`).
 * Already-synced listings cost no call, so every run advances.
 */
import { createHash } from 'node:crypto';
import type { PortalIssue } from '@inmolink/contracts';
import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import type { Logger } from '@inmolink/platform/logger';
import type { FeedItem } from '../../../feed-xml';
import * as search from '../../search';
import { decryptCredentials } from '../config';
import { agencyPresentation, buildItems, FEED_BATCH, type FeedPresenter } from '../feed';
import { portalFeedMediaBase } from '../generator';
import * as repo from '../repo';
import { selectConnectionListings, type WorkerConnection, workerConnections } from '../service';
import { validateItem } from '../validate';
import { OAuthPortalHttp } from './http';
import {
  DEFAULT_PUSH_CALLS_PER_RUN,
  isPushChannel,
  portalPushConfig,
  pushAdapterOf,
  pushChannelEnabled,
} from './registry';
import type { PortalAdapter, PortalHttp } from './types';
import { PortalPushError } from './types';

/** Time one run (every connection of the agency together) may spend: under the job's 10-minute limit. */
export const PUSH_RUN_BUDGET_MS = 8 * 60_000;
/** Adverts taken down per page in a teardown. */
const TEARDOWN_PAGE = 100;
/** Permanent connection-level stops that are stored on the connection and skipped until something changes. */
const STANDING = new Set(['AUTH_REJECTED', 'CREDENTIALS_MISSING', 'NOT_CONFIGURED', 'DESTINATION_BLOCKED']);

export interface PushConnectionOutcome {
  connectionId: string;
  mode: 'SYNC' | 'TEARDOWN';
  published: number;
  updated: number;
  withdrawn: number;
  /** Valid listings the portal already holds in this form. */
  unchanged: number;
  /** Refused by the portal (recorded FAILED), including refused withdrawals. */
  failed: number;
  /** Of `failed`, the withdrawals the portal refused. */
  withdrawFailed: number;
  /** Left out by validation. */
  invalid: number;
  /** Why the connection stopped before its end (error code), if it did. */
  stopped?: string;
  /** Calls or time ran out (or the portal asked to wait): a continuation runs shortly. */
  more?: boolean;
  /** `more`: the selection round to resume at (null: the start). */
  resume?: string | null;
  /** `more` because the portal said `Retry-After`: the wait. */
  retryAfterMs?: number;
}

export interface PushRunResult {
  skipped?: 'not-verified' | 'no-locales';
  connections: PushConnectionOutcome[];
}

interface PlannedPush {
  connection: WorkerConnection;
  adapter: PortalAdapter;
  mode: 'SYNC' | 'TEARDOWN';
  credentialsEnc: string | null;
  /** A standing stop the run does not try again (unless `retryStopped`). */
  pushError: string | null;
}

interface PushPlan {
  ready: PlannedPush[];
  locales: string[];
  baseLocale: string;
  presenter: FeedPresenter;
}

const NO_PRESENTER: FeedPresenter = {
  name: '',
  email: null,
  phone: null,
  whatsapp: null,
  website: null,
  primaryColor: null,
  accentColor: null,
};

/** Loads a run (one transaction, a handful of statements however many connections): modes, credentials, presenter. */
async function planPush(agencyId: string, connectionIds: readonly string[] | null): Promise<PushPlan> {
  return withSystem('exports.planPushPortals', async (tx) => {
    const rows = (await workerConnections(tx, agencyId, connectionIds)).filter((c) => isPushChannel(c.channelCode));
    const state = await repo.pushStateOf(
      tx,
      agencyId,
      rows.map((r) => r.id),
    );
    const flagOn = new Map<string, boolean>();
    for (const code of new Set(rows.map((r) => r.channelCode))) {
      flagOn.set(code, await pushChannelEnabled({ tx, tenant: { agencyId } }, code));
    }
    const wantsSync = (c: WorkerConnection) => c.enabled && flagOn.get(c.channelCode) === true;
    const shown = rows.some(wantsSync) ? await agencyPresentation(tx, agencyId) : null;
    const unverified = shown !== null && 'skipped' in shown && shown.skipped === 'not-verified';
    const noLocales = shown !== null && 'skipped' in shown && shown.skipped === 'no-locales';
    const ready: PlannedPush[] = [];
    for (const connection of rows) {
      const adapter = pushAdapterOf(connection.channelCode);
      if (!adapter) continue;
      const sync = wantsSync(connection) && !unverified;
      if (sync && noLocales) continue; // nothing to describe the listings in; not a reason to take anything down
      const s = state.get(connection.id);
      ready.push({
        connection,
        adapter,
        mode: sync ? 'SYNC' : 'TEARDOWN',
        credentialsEnc: s?.credentialsEnc ?? null,
        pushError: s?.pushError ?? null,
      });
    }
    const ok = shown !== null && !('skipped' in shown) ? shown : null;
    return {
      ready,
      locales: ok?.locales ?? [],
      baseLocale: ok?.baseLocale ?? '',
      presenter: ok?.presenter ?? NO_PRESENTER,
    };
  });
}

/** SHA-256 (base64url) of the payload's JSON: the change detector. Key order is the adapter's, so it is stable. */
export const payloadHash = (payload: unknown): string =>
  createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('base64url');

type Action =
  | {
      kind: 'PUBLISH' | 'UPDATE';
      propertyId: string;
      ref: string;
      payload: unknown;
      hash: string;
      remoteId: string | null;
    }
  | { kind: 'WITHDRAW'; propertyId: string; remoteId: string; hash: string };

interface Round {
  actions: Action[];
  unchanged: number;
  failedAlready: number;
  invalid: number;
  next: string | null;
}

const withdrawal = (row: repo.SyncRow & { remoteId: string }): Action => ({
  kind: 'WITHDRAW',
  propertyId: row.propertyId,
  remoteId: row.remoteId,
  hash: row.payloadHash,
});

/** One round of a connection (one transaction): selection, documents, validation, issues, and what to send. */
async function planRound(
  agencyId: string,
  p: PlannedPush,
  plan: PushPlan,
  cursor: string | null,
  size: number,
  runStart: Date,
): Promise<Round> {
  const { connection, adapter } = p;
  return withSystem('exports.pushPortals round', async (tx) => {
    const page = await selectConnectionListings(tx, connection, { cursor, limit: size });
    const docs = page.ids.length > 0 ? await search.ownListingDetails(tx, agencyId, page.ids, plan.locales) : [];
    const built = buildItems(page.ids, docs, {
      locales: plan.locales,
      baseLocale: plan.baseLocale,
      mediaBase: portalFeedMediaBase(),
      presenter: plan.presenter,
    });
    const items = new Map<string, FeedItem>(built.items.map((x) => [x.id, x.item]));
    const range = { after: cursor, upTo: page.nextCursor };
    const synced = new Map(
      (await repo.syncRowsInRange(tx, agencyId, connection.id, range)).map((r) => [r.propertyId, r]),
    );

    const failures: { propertyId: string; errors: PortalIssue[] }[] = [];
    const actions: Action[] = [];
    let unchanged = 0;
    let failedAlready = 0;
    for (const id of page.ids) {
      const item = items.get(id);
      if (!item) {
        failures.push({ propertyId: id, errors: [{ code: 'NO_DOCUMENT' }] });
        continue;
      }
      const issues = validateItem(adapter.profile, item);
      if (issues.length > 0) {
        failures.push({ propertyId: id, errors: issues });
        continue;
      }
      const payload = adapter.mapListing(item, plan.baseLocale);
      const hash = payloadHash(payload);
      const row = synced.get(id);
      const send = (kind: 'PUBLISH' | 'UPDATE', remoteId: string | null): Action => ({
        kind,
        propertyId: id,
        ref: item.base.ref,
        payload,
        hash,
        remoteId,
      });
      // Not on the portal (never sent, or withdrawn), or a withdrawal the portal refused (the advert is still up and
      // the listing is wanted again): send it.
      if (!row || row.state === 'WITHDRAWN' || row.errorCode === repo.WITHDRAW_REJECTED) {
        actions.push(send(row?.remoteId ? 'UPDATE' : 'PUBLISH', row?.remoteId ?? null));
      } else if (row.payloadHash === hash) {
        if (row.state === 'SYNCED') unchanged++;
        else failedAlready++;
      } else actions.push(send(row.remoteId ? 'UPDATE' : 'PUBLISH', row.remoteId));
    }
    // Adverts of listings the selection did not return for this id range: no longer sent, so taken down.
    const returned = new Set(page.ids);
    for (const row of synced.values()) {
      if (returned.has(row.propertyId) || !row.remoteId) continue;
      if (row.state === 'WITHDRAWN' || row.errorCode === repo.WITHDRAW_REJECTED) continue;
      actions.push(withdrawal({ ...row, remoteId: row.remoteId }));
    }
    await repo.syncIssues(tx, connection, range, failures, runStart);
    return { actions, unchanged, failedAlready, invalid: failures.length, next: page.nextCursor };
  });
}

/** Credentials of a connection, decrypted here only; a missing required key is a permanent, reported stop. */
function credentialsOf(agencyId: string, p: PlannedPush): { clientId: string; clientSecret: string } {
  const stored = p.credentialsEnc ? decryptCredentials(agencyId, p.connection.id, p.credentialsEnc) : {};
  for (const key of p.adapter.credentials.required) {
    if (!stored[key]) throw new PortalPushError('CREDENTIALS_MISSING', false, 'CONNECTION');
  }
  return { clientId: stored.clientId ?? '', clientSecret: stored.clientSecret ?? '' };
}

async function send(adapter: PortalAdapter, http: PortalHttp, a: Action): Promise<{ remoteId: string | null }> {
  switch (a.kind) {
    case 'PUBLISH':
      return adapter.publish(http, a.ref, a.payload);
    case 'UPDATE':
      try {
        return await adapter.update(http, a.remoteId as string, a.payload);
      } catch (err) {
        // The portal lost the advert: create it again.
        if (err instanceof PortalPushError && err.code === 'NOT_FOUND') return adapter.publish(http, a.ref, a.payload);
        throw err;
      }
    case 'WITHDRAW':
      await adapter.withdraw(http, a.remoteId);
      return { remoteId: a.remoteId };
  }
}

interface RunLimits {
  /** Epoch ms: the run's deadline, shared by every connection of the pass. */
  deadline: number;
  maxCalls: number;
  batchSize: number;
  /** A continuation's selection round (one connection). */
  cursor: string | null;
  retryStopped: boolean;
  signal?: AbortSignal;
  log?: Logger;
}

const outOfTime = (limits: RunLimits) => clock.now().getTime() >= limits.deadline;

async function runConnection(
  agencyId: string,
  p: PlannedPush,
  plan: PushPlan,
  limits: RunLimits,
): Promise<{ outcome: PushConnectionOutcome; error?: PortalPushError }> {
  const { connection, adapter } = p;
  const outcome: PushConnectionOutcome = {
    connectionId: connection.id,
    mode: p.mode,
    published: 0,
    updated: 0,
    withdrawn: 0,
    unchanged: 0,
    failed: 0,
    withdrawFailed: 0,
    invalid: 0,
  };
  // A standing problem (rejected credentials, ...) waits for a person; the nightly run looks again.
  if (p.pushError && !limits.retryStopped) {
    outcome.stopped = p.pushError;
    return { outcome };
  }
  const config = portalPushConfig();
  const endpoints = config.endpoints[connection.channelCode];
  let cursor = limits.cursor;
  try {
    if (!endpoints) throw new PortalPushError('NOT_CONFIGURED', false, 'CONNECTION');
    const { clientId, clientSecret } = credentialsOf(agencyId, p);
    const http = new OAuthPortalHttp({
      endpoints,
      clientId,
      clientSecret,
      signal: limits.signal,
      fetchOptions: config.fetchOptions,
    });
    const runStart = clock.now();
    let calls = 0;

    /** Sends the actions in order, within the call and time budgets; the results are saved even if a call throws. */
    const execute = async (actions: readonly Action[]): Promise<void> => {
      const writes: repo.SyncWrite[] = [];
      let failure: PortalPushError | undefined;
      try {
        for (const a of actions) {
          if (calls >= limits.maxCalls || outOfTime(limits)) {
            outcome.more = true;
            break;
          }
          calls++;
          try {
            const done = await send(adapter, http, a);
            const syncedAt = clock.now();
            if (a.kind === 'WITHDRAW') {
              outcome.withdrawn++;
              writes.push({ ...baseWrite(a), state: 'WITHDRAWN', remoteId: a.remoteId, errorCode: null, syncedAt });
            } else {
              if (a.kind === 'PUBLISH') outcome.published++;
              else outcome.updated++;
              writes.push({ ...baseWrite(a), state: 'SYNCED', remoteId: done.remoteId, errorCode: null, syncedAt });
            }
          } catch (err) {
            if (!(err instanceof PortalPushError)) throw err;
            if (err.scope === 'CONNECTION') {
              failure = err;
              break;
            }
            outcome.failed++;
            // A refused payload is remembered (not sent again until it changes). A refused withdrawal is remembered
            // too, with the advert's id: it is not asked again, so `more` cannot loop on it.
            if (a.kind === 'WITHDRAW') {
              outcome.withdrawFailed++;
              writes.push({
                ...baseWrite(a),
                state: 'FAILED',
                remoteId: a.remoteId,
                errorCode: repo.WITHDRAW_REJECTED,
                syncedAt: clock.now(),
              });
            } else {
              writes.push({
                ...baseWrite(a),
                state: 'FAILED',
                remoteId: a.remoteId,
                errorCode: err.code.slice(0, 40),
                syncedAt: clock.now(),
              });
            }
          }
        }
      } finally {
        if (writes.length > 0) {
          await withSystem('exports.pushPortals record', (tx) =>
            repo.upsertSyncRows(tx, agencyId, connection.id, writes),
          );
        }
      }
      if (failure) throw failure;
    };

    if (p.mode === 'TEARDOWN') {
      for (;;) {
        if (outOfTime(limits)) {
          outcome.more = true;
          break;
        }
        const up = await withSystem('exports.pushPortals teardown', (tx) =>
          repo.liveAdverts(tx, agencyId, connection.id, TEARDOWN_PAGE),
        );
        if (up.length === 0) break;
        const before = outcome.withdrawn + outcome.withdrawFailed;
        await execute(up.map((row) => withdrawal({ ...row, remoteId: row.remoteId as string })));
        if (outcome.more || outcome.withdrawn + outcome.withdrawFailed === before) break;
      }
    } else {
      const startedAt = cursor;
      do {
        if (outOfTime(limits)) {
          outcome.more = true;
          break;
        }
        const round = await planRound(agencyId, p, plan, cursor, limits.batchSize, runStart);
        outcome.unchanged += round.unchanged;
        outcome.failed += round.failedAlready;
        outcome.invalid += round.invalid;
        await execute(round.actions);
        if (outcome.more) break;
        cursor = round.next;
      } while (cursor !== null);

      // The summary is a whole-selection figure: only a run that started at the beginning and finished has it.
      if (!outcome.more && startedAt === null) {
        await withSystem('exports.pushPortals summary', (tx) =>
          repo.setValidationSummary(tx, agencyId, connection.id, {
            checkedAt: runStart,
            valid: outcome.published + outcome.updated + outcome.unchanged + outcome.failed - outcome.withdrawFailed,
            invalid: outcome.invalid,
          }),
        );
      }
    }
    if (outcome.more) outcome.resume = cursor;
    if (p.pushError)
      await withSystem('exports.pushPortals clear', (tx) => repo.setPushError(tx, agencyId, connection.id, null));
    limits.log?.info({ channel: connection.channelCode, ...outcome }, 'portal push finished');
    return { outcome };
  } catch (err) {
    if (!(err instanceof PortalPushError)) throw err;
    outcome.stopped = err.code;
    limits.log?.warn(
      { connectionId: connection.id, channel: connection.channelCode, code: err.code, retryable: err.retryable },
      'portal push stopped',
    );
    // The portal said how long to wait: a continuation after that, from where this run was; no job retry.
    if (err.retryable && err.retryAfterMs !== undefined) {
      outcome.more = true;
      outcome.resume = cursor;
      outcome.retryAfterMs = err.retryAfterMs;
      return { outcome };
    }
    // A permanent problem is stored (never for missing endpoints: that is the deployment's, not the connection's).
    if (!err.retryable && endpoints && STANDING.has(err.code) && p.pushError !== err.code) {
      await withSystem('exports.pushPortals standing stop', (tx) =>
        repo.setPushError(tx, agencyId, connection.id, err.code),
      );
    }
    return { outcome, error: err };
  }
}

const baseWrite = (a: Action) => ({ propertyId: a.propertyId, payloadHash: a.hash });

/**
 * One push run over an agency (worker): the named connections, or every live push connection. Returns what each did.
 * Throws the first retryable connection-level error (without a `Retry-After`) after every connection has had its turn,
 * so the job retries; a permanent one is in the outcome's `stopped` and waits for a person.
 *
 * `cursor`: a continuation's selection round (with exactly one connection). `retryStopped`: connections with a
 * standing stop try again (the nightly run).
 */
export async function pushPortalListings(
  agencyId: string,
  opts: {
    connectionIds?: readonly string[];
    cursor?: string;
    retryStopped?: boolean;
    signal?: AbortSignal;
    log?: Logger;
  } = {},
): Promise<PushRunResult> {
  const config = portalPushConfig();
  const plan = await planPush(agencyId, opts.connectionIds ?? null);
  const result: PushRunResult = { connections: [] };
  // One deadline for the whole run: two connections cannot add up past the job's timeout.
  const limits: RunLimits = {
    deadline: clock.now().getTime() + (config.runBudgetMs ?? PUSH_RUN_BUDGET_MS),
    maxCalls: config.maxCallsPerRun ?? DEFAULT_PUSH_CALLS_PER_RUN,
    batchSize: config.batchSize ?? FEED_BATCH,
    cursor: plan.ready.length === 1 ? (opts.cursor ?? null) : null,
    retryStopped: opts.retryStopped ?? false,
    signal: opts.signal,
    log: opts.log,
  };
  let retryable: PortalPushError | undefined;
  for (const p of plan.ready) {
    opts.signal?.throwIfAborted();
    const { outcome, error } = await runConnection(agencyId, p, plan, limits);
    result.connections.push(outcome);
    if (error?.retryable) retryable ??= error;
  }
  if (retryable) throw retryable;
  return result;
}
