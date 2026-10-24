import { createHash } from 'node:crypto';
import {
  type ActivityDto,
  type ActivityPage,
  AppError,
  CRM_ACTIVITY_LIMITS,
  type CreateActivityBody,
  type ListActivitiesQuery,
} from '@inmolink/contracts';
import { type Tx, withTenant } from '@inmolink/db';
import { safeEqual } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import type { Ctx } from '../../context';
import { decodeCursor, toPage } from '../../pagination';
import * as properties from '../properties';
import * as activitiesRepo from './activities-repo';
import { assertCan } from './policy';

/**
 * The activity timeline (S10-04, PLAN §6 CRM): one partitioned table (`activities`, monthly) that every timeline reads —
 * a contact's, a lead's, a listing's, or the agency's whole feed — newest first, keyset on `(occurred_at, id)`.
 *
 * Writers:
 *  - a member logs a call, e-mail, meeting or viewing (`logActivity`, `POST /v1/crm/activities`);
 *  - a note on a contact records `NOTE_ADDED` in the note's own transaction (`service.addContactNote`);
 *  - other changes arrive through the outbox (`subscriptions.ts` → `crm.recordActivity`, one job per event):
 *    `crm.lead.created` (`LEAD_CREATED`, website leads included once promoted), `crm.lead.updated` (`LEAD_UPDATED`),
 *    `crm.lead.stageChanged` (`STAGE_CHANGED`, S10-03),
 *    `crm.contact.merged` (`CONTACT_MERGED` on the survivor) and `properties.listing.statusChanged`
 *    (`LISTING_STATUS_CHANGED`). The row takes the event's id and time, so a redelivery adds nothing.
 * A purged listing leaves the timelines (`forgetListingActivities`). Activities never point at a closed contact: a
 * merge (the only way a contact closes) re-points them in its transaction, and writers check the contact is open.
 */

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const userIdOf = (ctx: Ctx): string | null => (ctx.actor.kind === 'user' ? ctx.actor.userId : null);
const IDEMPOTENCY_WINDOW_MS = 24 * 3_600_000;
const DAY_MS = 86_400_000;
/** A logged time may run this far ahead of the server's clock (a client's clock skew), never more. */
const CLOCK_SKEW_MS = 60_000;
/** How much of a note the timeline repeats. */
export const NOTE_EXCERPT_CHARS = 280;

export function toActivityDto(row: activitiesRepo.ActivityRow): ActivityDto {
  return {
    id: row.id,
    type: row.type as ActivityDto['type'],
    occurredAt: row.occurredAt.toISOString(),
    contactId: row.contactId,
    leadId: row.leadId,
    listingId: row.listingId,
    actorUserId: row.actorUserId,
    body: row.body,
    data: row.data && typeof row.data === 'object' ? (row.data as Record<string, unknown>) : {},
  };
}

/**
 * `GET /v1/crm/activities`: a contact's, lead's or listing's timeline (or the agency's feed), newest first, keyset
 * (≤ 100 per page); `type` filters. A contact or lead of another agency (or none) is `*_NOT_FOUND`; a listing is not
 * looked up — RLS keeps the rows to the agency's own, so another agency's listing has an empty timeline. Two queries.
 */
export async function listActivities(ctx: Ctx, query: ListActivitiesQuery): Promise<ActivityPage> {
  assertCan(ctx, 'crm.activities.read');
  const cursor = decodeCursor(query.cursor);
  const agencyId = ctx.tenant.agencyId;
  const filter: activitiesRepo.ActivityFilter = {};
  if (query.subject && query.subjectId) {
    if (query.subject === 'CONTACT') {
      if (!(await activitiesRepo.contactOpen(ctx.tx, agencyId, query.subjectId))) {
        throw new AppError('CONTACT_NOT_FOUND');
      }
      filter.subject = { column: 'contact', id: query.subjectId };
    } else if (query.subject === 'LEAD') {
      if (!(await activitiesRepo.leadSubjects(ctx.tx, agencyId, query.subjectId))) throw new AppError('LEAD_NOT_FOUND');
      filter.subject = { column: 'lead', id: query.subjectId };
    } else {
      filter.subject = { column: 'listing', id: query.subjectId };
    }
  }
  if (query.type) filter.types = query.type;
  const rows = await activitiesRepo.listActivities(
    ctx.tx,
    agencyId,
    filter,
    cursor ? { limit: query.limit, cursor } : { limit: query.limit },
  );
  return toPage(rows, query.limit, (r) => ({ at: r.occurredAt, id: r.id }), toActivityDto);
}

/**
 * `POST /v1/crm/activities`: a member logs a call, e-mail, meeting or viewing about a contact, a lead and/or one of the
 * agency's listings. A lead fills in its contact (and its own listing) when they are not sent, so the activity shows on
 * each timeline. `occurredAt` may be up to `CRM_ACTIVITY_LIMITS.backdateDays` back (the months kept online ahead of
 * time), never ahead. With an `Idempotency-Key`, a retry by the same member within 24 h with the same body answers the
 * first activity; another body is `IDEMPOTENCY_KEY_REUSED` (the key's advisory lock serializes concurrent retries: a
 * unique index on a partitioned table must include the month).
 */
export async function logActivity(
  ctx: Ctx,
  input: CreateActivityBody,
  opts: { idempotencyKey?: string } = {},
): Promise<{ activity: ActivityDto; replayed: boolean }> {
  assertCan(ctx, 'crm.activities.write');
  const agencyId = ctx.tenant.agencyId;
  const now = Date.now();
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date(now);
  if (
    occurredAt.getTime() > now + CLOCK_SKEW_MS ||
    occurredAt.getTime() < now - CRM_ACTIVITY_LIMITS.backdateDays * DAY_MS
  ) {
    throw new AppError('ACTIVITY_DATE_OUT_OF_RANGE');
  }
  const idempotency = opts.idempotencyKey
    ? {
        hash: sha256(`crm.activity:${userIdOf(ctx)}:${opts.idempotencyKey}`),
        requestHash: sha256(JSON.stringify(input)),
      }
    : null;
  if (idempotency) {
    await activitiesRepo.lockIdempotency(ctx.tx, idempotency.hash);
    const prior = await activitiesRepo.activityByIdempotency(
      ctx.tx,
      agencyId,
      idempotency.hash,
      new Date(now - IDEMPOTENCY_WINDOW_MS),
      new Date(now - (CRM_ACTIVITY_LIMITS.backdateDays + 1) * DAY_MS),
    );
    if (prior) {
      if (!prior.requestHash || !safeEqual(prior.requestHash, idempotency.requestHash)) {
        throw new AppError('IDEMPOTENCY_KEY_REUSED');
      }
      return { activity: toActivityDto(prior.row), replayed: true };
    }
  }

  let contactId = input.contactId ?? null;
  let listingId = input.listingId ?? null;
  if (input.leadId) {
    const lead = await activitiesRepo.leadSubjects(ctx.tx, agencyId, input.leadId);
    if (!lead) throw new AppError('LEAD_NOT_FOUND');
    // the lead's activity is about the lead's client: another contact is a mistake, not a second subject
    if (contactId && contactId !== lead.contactId) throw new AppError('VALIDATION_FAILED', { field: 'contactId' });
    contactId ??= lead.contactId;
    listingId ??= lead.listingId;
  }
  if (input.contactId && !(await activitiesRepo.contactOpen(ctx.tx, agencyId, input.contactId))) {
    throw new AppError('CONTACT_NOT_FOUND');
  }
  if (input.listingId) {
    const listing = await properties.leadTargetListing(ctx.tx, agencyId, input.listingId);
    if (!listing || listing.agencyId !== agencyId) throw new AppError('LISTING_NOT_FOUND');
  }

  const [row] = await activitiesRepo.insertActivities(ctx.tx, [
    {
      id: newId(),
      agencyId,
      occurredAt,
      type: input.type,
      contactId,
      leadId: input.leadId ?? null,
      listingId,
      actorUserId: userIdOf(ctx),
      idempotencyHash: idempotency?.hash ?? null,
      requestHash: idempotency?.requestHash ?? null,
      body: input.body ?? null,
    },
  ]);
  if (!row) throw new AppError('INTERNAL');
  return { activity: toActivityDto(row), replayed: false };
}

/** `NOTE_ADDED` on the contact's timeline, in the note's transaction (crm's own write: no event needed). */
export async function recordNoteAdded(
  tx: Tx,
  note: { id: string; agencyId: string; contactId: string; authorUserId: string | null; body: string; createdAt: Date },
): Promise<void> {
  await activitiesRepo.insertActivities(tx, [
    {
      id: newId(),
      agencyId: note.agencyId,
      occurredAt: note.createdAt,
      type: 'NOTE_ADDED',
      contactId: note.contactId,
      actorUserId: note.authorUserId,
      // whole characters (code points): never half of a surrogate pair
      body: Array.from(note.body).slice(0, NOTE_EXCERPT_CHARS).join(''),
      data: { noteId: note.id },
    },
  ]);
}

/** A change announced through the outbox, as the `crm.recordActivity` job receives it (IDs and codes only). */
export interface RecordedActivity {
  eventId: string;
  agencyId: string;
  /** The event's time (ISO): the activity's, so a redelivery maps to the same row. */
  occurredAt: string;
  type: 'LEAD_CREATED' | 'LEAD_UPDATED' | 'STAGE_CHANGED' | 'CONTACT_MERGED' | 'LISTING_STATUS_CHANGED';
  contactId?: string | undefined;
  leadId?: string | undefined;
  listingId?: string | undefined;
  data: Record<string, string | number | null>;
}

/**
 * `crm.recordActivity`: writes the event's activity under the event's agency (RLS), once (`activities_event_uq`). A lead's
 * activity also names its contact and own listing (read now: a merge since the event has re-pointed the lead). A lead
 * gone since (deleted) records nothing.
 */
export async function recordActivity(p: RecordedActivity): Promise<{ recorded: boolean }> {
  return withTenant({ agencyId: p.agencyId }, async (tx) => {
    let contactId = p.contactId ?? null;
    let listingId = p.listingId ?? null;
    if (p.leadId) {
      const lead = await activitiesRepo.leadSubjects(tx, p.agencyId, p.leadId);
      if (!lead) return { recorded: false };
      contactId ??= lead.contactId;
      listingId ??= lead.listingId;
    }
    if (p.type === 'CONTACT_MERGED' && contactId && !(await activitiesRepo.contactOpen(tx, p.agencyId, contactId))) {
      return { recorded: false };
    }
    try {
      const rows = await activitiesRepo.insertActivities(tx, [
        {
          id: newId(),
          agencyId: p.agencyId,
          occurredAt: new Date(p.occurredAt),
          type: p.type,
          contactId,
          leadId: p.leadId ?? null,
          listingId,
          eventId: p.eventId,
          data: p.data,
        },
      ]);
      return { recorded: rows.length > 0 };
    } catch (err) {
      // 23514: no month holds the event's time (partition maintenance behind) or a check refused the row — a retry
      // cannot succeed, so the job fails at once (non-retryable) with the event's id, instead of five times
      if (sqlStateOf(err) === '23514') {
        throw new AppError('INTERNAL', { eventId: p.eventId, reason: 'ACTIVITY_NOT_STORABLE' }, false);
      }
      throw err;
    }
  });
}

/** The SQLSTATE of a failed statement (drizzle wraps the driver's error as `cause`). */
function sqlStateOf(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  const code = e.cause?.code ?? e.code;
  return typeof code === 'string' ? code : undefined;
}

/** Rows per statement when a purged listing leaves the timelines. */
const FORGET_BATCH = 1_000;

/**
 * `crm.forgetListingActivities` (after `properties.listing.purged`): the listing leaves the agency's timelines — its own
 * activities are deleted, a lead's or contact's activity loses only the listing. Batches of 1,000, a transaction each
 * (idempotent: a rerun finds nothing left).
 */
export async function forgetListingActivities(p: { agencyId: string; listingId: string }): Promise<{ rows: number }> {
  let total = 0;
  for (;;) {
    const n = await withTenant({ agencyId: p.agencyId }, (tx) =>
      activitiesRepo.forgetListing(tx, p.agencyId, p.listingId, FORGET_BATCH),
    );
    total += n;
    if (n < FORGET_BATCH) return { rows: total };
  }
}
