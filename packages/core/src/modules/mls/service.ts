/**
 * mls use cases (PATTERNS §7): `(ctx: Ctx, input) → DTO`. Authorize with `assertCan`, read and
 * write through `./repo`, emit outbox events in the same transaction, never call the network.
 */
import type {
  CreateRegistrationBody,
  ListRegistrationsQuery,
  ReceivedRegistrationDto,
  ReceivedRegistrationPage,
  RegistrationDto,
  RegistrationPage,
  RegistrationTargetKind,
} from '@inmolink/contracts';
import { withTenant } from '@inmolink/db';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { type RateLimitRule, rateLimiter } from '@inmolink/platform/rate-limit';
import type { Ctx, CtxRunner } from '../../context';
import { advisoryLock } from '../../idempotency';
import { decodeCursor, toPage } from '../../pagination';
import * as agencies from '../agencies';
import * as compliance from '../compliance';
import * as crm from '../crm';
import * as developments from '../developments';
import * as properties from '../properties';
import { clientFingerprints, type RegisteredClient, registeredClientCipher } from './config';
import { mlsEvents } from './events';
import { assertCan } from './policy';
import * as repo from './repo';
import * as viewingsRepo from './viewings-repo';

/**
 * The conflict-probe budget (S11-01 security review): each `REGISTRATION_CONFLICT` tells the caller that some agency
 * registered that client for that target, so an agency gets 20 a day; the 21st trips a day's penalty during which every
 * registration of the agency answers `RATE_LIMITED` (a success would answer the same question).
 */
export const REGISTRATION_CONFLICT_BUDGET = {
  name: 'mls.registration-conflicts',
  scope: 'tenant',
  limit: 20,
  windowSeconds: 86_400,
  penaltySeconds: 86_400,
  // Redis down: no registration rather than an unbudgeted oracle
  failClosed: true,
} as const satisfies RateLimitRule;

export interface RegisterClientResult {
  /** `CREATED`: a new registration; `EXISTING`: the agency's own registration of this client, still valid. */
  outcome: 'CREATED' | 'EXISTING';
  registration: RegistrationDto;
}

type Attempt = RegisterClientResult | { outcome: 'CONFLICT'; retryAfterSeconds: number | null };

/** The registration's owner agency, as the caller sees the target (another agency's network listing or development). */
async function targetOwner(ctx: Ctx, kind: RegistrationTargetKind, id: string): Promise<string> {
  const owner =
    kind === 'LISTING'
      ? ((await properties.leadTargetListing(ctx.tx, ctx.tenant.agencyId, id))?.agencyId ?? null)
      : await developments.leadTargetOwner(ctx.tx, 'DEVELOPMENT', id);
  // RLS shows another agency's target only while it is on the network; a registration to one's own target is moot
  if (!owner || owner === ctx.tenant.agencyId) throw new AppError('REGISTRATION_TARGET_NOT_FOUND');
  return owner;
}

function toDto(ctx: Ctx, r: repo.OwnRegistrationRow): RegistrationDto {
  return {
    id: r.id,
    contactId: r.contactId,
    client: registeredClientCipher.decrypt(ctx.tenant.agencyId, r.id, r.detailsEnc),
    target: { kind: r.targetKind as RegistrationTargetKind, id: r.targetId },
    ownerAgencyId: r.targetAgencyId,
    registeredByUserId: r.registeredByUserId,
    registeredAt: r.registeredAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    state: r.active ? 'ACTIVE' : 'EXPIRED',
  };
}

async function loadOwn(ctx: Ctx, id: string): Promise<RegistrationDto> {
  const row = await repo.getOwn(ctx.tx, ctx.tenant.agencyId, id);
  if (!row) throw new Error(`mls: registration ${id} vanished in its own transaction`);
  return toDto(ctx, row);
}

/** A 23P01: the exclusion constraint (the only one these tables have). Its pg `detail` names fingerprints and ranges. */
const isExclusionViolation = (err: unknown): boolean =>
  (err as { cause?: { code?: string } }).cause?.code === '23P01' || (err as { code?: string }).code === '23P01';

async function attemptRegistration(ctx: Ctx, input: CreateRegistrationBody): Promise<Attempt> {
  assertCan(ctx, 'mls.registrations.write');
  const agencyId = ctx.tenant.agencyId;
  // One agency's registrations run one at a time (security review): the budget's peek and count below then see every
  // earlier attempt of the agency, so parallel probes cannot all pass the peek.
  await advisoryLock(ctx.tx, `mls.reg:${agencyId}`);
  // The probe penalty: an agency in it registers nothing.
  const [penalty] = await rateLimiter().consumeMany([
    { rule: REGISTRATION_CONFLICT_BUDGET, identity: agencyId, peek: true },
  ]);
  if (penalty && !penalty.allowed) {
    throw new AppError('RATE_LIMITED', { retryAfterSeconds: penalty.retryAfterSeconds });
  }

  const contact = await crm.getContact(ctx, input.contactId);
  const prints = clientFingerprints(contact);
  if (prints.current.length === 0) {
    throw new AppError('VALIDATION_FAILED', { field: 'contactId', reason: 'no_email_or_phone' });
  }
  const targetAgencyId = await targetOwner(ctx, input.target.kind, input.target.id);

  const own = await repo.findOwnValid(ctx.tx, agencyId, input.target.id, prints.candidates);
  if (own) return { outcome: 'EXISTING', registration: await loadOwn(ctx, own) };

  const { registrationValidityDays } = await agencies.getAgencySettings(ctx);
  const id = newId();
  const client: RegisteredClient = {
    firstName: contact.firstName,
    lastName: contact.lastName,
    emails: contact.emails,
    phones: contact.phones,
  };
  const registeredByUserId = ctx.actor.kind === 'user' ? ctx.actor.userId : null;
  let at: { registeredAt: Date; expiresAt: Date };
  try {
    // A savepoint: a lost race leaves the transaction usable for the checks below.
    at = await ctx.tx.transaction((sp) =>
      repo.insertRegistration(sp, {
        id,
        agencyId,
        targetAgencyId,
        targetKind: input.target.kind,
        targetId: input.target.id,
        validityDays: registrationValidityDays,
        contactId: contact.id,
        registeredByUserId,
        detailsEnc: registeredClientCipher.encrypt(agencyId, id, client),
        fingerprints: prints.candidates,
      }),
    );
  } catch (err) {
    // Never rethrown: the pg error's detail carries the fingerprint and the other registration's range.
    if (!isExclusionViolation(err)) throw err;
    // The agency's own concurrent registration of the client won the race: answer it.
    const mine = await repo.findOwnValid(ctx.tx, agencyId, input.target.id, prints.candidates);
    if (mine) return { outcome: 'EXISTING', registration: await loadOwn(ctx, mine) };
    await compliance.audit(ctx, 'mls.registration.conflicted', null, {
      targetKind: input.target.kind,
      targetId: input.target.id,
      contactId: contact.id,
    });
    // Counted under the lock, before the next attempt of the agency can peek.
    const budget = await rateLimiter().consume(REGISTRATION_CONFLICT_BUDGET, agencyId);
    return { outcome: 'CONFLICT', retryAfterSeconds: budget.allowed ? null : budget.retryAfterSeconds };
  }

  await emit(
    ctx.tx,
    mlsEvents.registrationCreated({
      agencyId,
      registrationId: id,
      targetAgencyId,
      targetKind: input.target.kind,
      targetId: input.target.id,
      expiresMs: at.expiresAt.getTime(),
    }),
  );
  return {
    outcome: 'CREATED',
    registration: {
      id,
      contactId: contact.id,
      client,
      target: input.target,
      ownerAgencyId: targetAgencyId,
      registeredByUserId,
      registeredAt: at.registeredAt.toISOString(),
      expiresAt: at.expiresAt.toISOString(),
      state: 'ACTIVE',
    },
  };
}

/**
 * `POST /v1/mls/registrations` (S11-01, PLAN §3 #8): the introducer registers one of its contacts for another agency's
 * listing or development. The client's e-mails and phones (normalized here) become keyed fingerprints (HMAC,
 * `HMAC_KEY`; every key candidate during a rotation window); the details are stored encrypted. Valid from the
 * database's `now()` for the shorter of the introducer's and the owner's `registrationValidityDays`. First valid wins:
 * when another agency's registration of any fingerprint for the target is still valid, the insert hits the exclusion
 * constraint and the answer is `REGISTRATION_CONFLICT` — saying nothing of that registration — audited, and counted
 * against the agency's probe budget (`RATE_LIMITED` beyond it). The agency's own valid registration of the client (this
 * contact or a duplicate of it, or a concurrent request's) is answered as is (`EXISTING`).
 *
 * One transaction (`CtxRunner`), under a per-agency advisory lock; a conflict commits its audit row (the error is thrown
 * after the commit). The budget is read and counted in Redis under the lock (`failClosed`). ≤ 10 statements on the
 * created path (lock, contact, target, own check, settings, savepoint, the insert, release, outbox).
 */
export async function registerClient(run: CtxRunner, input: CreateRegistrationBody): Promise<RegisterClientResult> {
  const attempt = await run((ctx) => attemptRegistration(ctx, input));
  if (attempt.outcome !== 'CONFLICT') return attempt;
  if (attempt.retryAfterSeconds !== null) {
    throw new AppError('RATE_LIMITED', { retryAfterSeconds: attempt.retryAfterSeconds });
  }
  throw new AppError('REGISTRATION_CONFLICT');
}

/** The filters, with the agency's time zone when a day range needs it (one more query, only then). */
async function registrationFilter(ctx: Ctx, q: ListRegistrationsQuery): Promise<repo.RegistrationFilter> {
  const timeZone = q.from || q.to ? await agencies.agencyTimeZone(ctx.tx, ctx.tenant.agencyId) : undefined;
  return { state: q.state, kind: q.kind, from: q.from, to: q.to, timeZone };
}

/** `GET /v1/mls/registrations`: the agency's registrations with their clients, newest first, keyset (one query). */
export async function listRegistrations(ctx: Ctx, query: ListRegistrationsQuery): Promise<RegistrationPage> {
  assertCan(ctx, 'mls.registrations.read');
  const cursor = decodeCursor(query.cursor);
  const rows = await repo.listOwn(ctx.tx, ctx.tenant.agencyId, {
    limit: query.limit,
    filter: await registrationFilter(ctx, query),
    ...(cursor ? { cursor } : {}),
  });
  return toPage(
    rows,
    query.limit,
    (r) => ({ at: r.registeredMs, id: r.id }),
    (r) => toDto(ctx, r),
  );
}

/**
 * `GET /v1/mls/received-registrations`: the owner's side — which agency registered a client for which of its targets
 * and until when ("registered by Agency X"), never the client. Newest first, keyset over the owner's receipts; two
 * queries (the page, the introducers' directory names).
 */
export async function listReceivedRegistrations(
  ctx: Ctx,
  query: ListRegistrationsQuery,
): Promise<ReceivedRegistrationPage> {
  assertCan(ctx, 'mls.registrations.read');
  const cursor = decodeCursor(query.cursor);
  const rows = await repo.listReceipts(ctx.tx, ctx.tenant.agencyId, {
    limit: query.limit,
    filter: await registrationFilter(ctx, query),
    ...(cursor ? { cursor } : {}),
  });
  const page = rows.slice(0, query.limit);
  const names =
    page.length > 0
      ? await agencies.networkAgencyNames(ctx, [...new Set(page.map((r) => r.introducerAgencyId))])
      : new Map<string, string>();
  return toPage(
    rows,
    query.limit,
    (r) => ({ at: r.registeredMs, id: r.registrationId }),
    (r): ReceivedRegistrationDto => ({
      id: r.registrationId,
      introducerAgencyId: r.introducerAgencyId,
      introducerName: names.get(r.introducerAgencyId) ?? null,
      target: { kind: r.targetKind as RegistrationTargetKind, id: r.targetId },
      registeredAt: r.registeredAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      state: r.active ? 'ACTIVE' : 'EXPIRED',
    }),
  );
}

/**
 * A contact merge (`crm.contact.merged`, worker job `mls.repointRegistrations`): the agency's registrations of the closed
 * contact name the survivor. Under the agency's RLS (`withTenant`); idempotent — a redelivery finds nothing to move.
 */
export async function repointRegistrations(p: {
  agencyId: string;
  survivorId: string;
  mergedId: string;
}): Promise<{ rows: number }> {
  const rows = await withTenant({ agencyId: p.agencyId }, async (tx) => {
    const registrations = await repo.repointContact(tx, p.agencyId, p.mergedId, p.survivorId);
    // S11-02: its viewing requests follow (they name the same contact)
    const viewings = await viewingsRepo.repointContact(tx, p.agencyId, p.mergedId, p.survivorId);
    return registrations + viewings;
  });
  return { rows };
}
