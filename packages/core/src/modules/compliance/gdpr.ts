import {
  CONSENT_HISTORY_LIMIT,
  type ConsentRecordDto,
  type ConsentSource,
  RETENTION_GRACE_DAYS,
  type RetentionSettingsDto,
} from '@inmolink/contracts';
import { type Tx, withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { storage } from '@inmolink/platform/storage';
import type { Ctx } from '../../context';
import { dataExportKey } from './data-export';
import * as exportRepo from './data-export-repo';
import * as repo from './gdpr-repo';
import { assertCan } from './policy';
import { audit } from './service';

/**
 * GDPR flows, the request side (S16-04, PLAN §13): consent records, the agency's retention period, and the expiry of
 * data export files that hold an erased person. The erasure itself is crm's (`crm.eraseContact`); the agency erasure
 * is the `ERASE_AGENCY` staff operation (`compliance/worker.ts` `eraseAgencyData`).
 */

// ---- consent records ----

/** What changed about one contact's consent (only real changes: the caller compares with the current state). */
export interface ConsentChange {
  contactId: string;
  purpose: 'MARKETING' | 'PROCESSING';
  granted: boolean;
}

/**
 * Appends consent records in the caller's transaction (the change and its record commit together). `who`: a member's
 * context (its user, and the staff member impersonating it), or a source without a member (a website form, an import).
 * `policyVersion`: the privacy text version the form showed, when known (website / portal forms: `LEGAL_TEXT_VERSION`).
 * `at`: when the choice was made, if earlier than now (a form handled by a job); else the database's time.
 * Callers pass real changes only (a value that did not change is no record), or a choice the person made again on a
 * form, which is evidence in itself (S17-F33).
 */
export async function recordConsents(
  tx: Tx,
  agencyId: string,
  changes: readonly ConsentChange[],
  who: { source: ConsentSource; ctx?: Ctx; policyVersion?: string | null; at?: Date },
): Promise<void> {
  if (changes.length === 0) return;
  const actor = who.ctx?.actor.kind === 'user' ? who.ctx.actor : null;
  await repo.insertConsents(
    tx,
    changes.map((c) => ({
      id: newId(),
      agencyId,
      contactId: c.contactId,
      purpose: c.purpose,
      granted: c.granted,
      source: who.source,
      policyVersion: who.policyVersion ?? null,
      actorUserId: actor?.userId ?? null,
      impersonatedBy: actor?.impersonatedBy ?? null,
      ...(who.at ? { recordedAt: who.at } : {}),
    })),
  );
}

/** The consents a new contact starts with (each one granted is a record; nothing granted, nothing to record). */
export function initialConsents(
  contactId: string,
  c: { consentMarketing?: boolean; consentProcessing?: boolean },
): ConsentChange[] {
  const out: ConsentChange[] = [];
  if (c.consentMarketing) out.push({ contactId, purpose: 'MARKETING', granted: true });
  if (c.consentProcessing) out.push({ contactId, purpose: 'PROCESSING', granted: true });
  return out;
}

/**
 * Proof that the caller read the contact through crm's access check (S16-04 review): crm's `listContactConsents` passes
 * the contact it loaded under the member's policy and RLS (`crm.contacts.read`); nothing else holds one. Compliance
 * checks it names a contact of the request's agency.
 */
export interface ContactReadProof {
  readonly kind: 'crm.contact';
  readonly id: string;
  readonly agencyId: string;
}

/**
 * A contact's consent history, newest first (`GET /v1/crm/contacts/:id/consents`). Callable only with a
 * `ContactReadProof` from crm (the contact as crm loaded it for this member). Staff identities are not shown:
 * `impersonated` only.
 */
export async function listConsents(ctx: Ctx, contact: ContactReadProof): Promise<ConsentRecordDto[]> {
  assertCan(ctx, 'compliance.consents.read', { agencyId: contact.agencyId });
  if (contact.kind !== 'crm.contact') throw new AppError('FORBIDDEN');
  const rows = await repo.consentsOf(ctx.tx, ctx.tenant.agencyId, contact.id, CONSENT_HISTORY_LIMIT);
  return rows.map((r) => ({
    id: r.id,
    purpose: r.purpose as ConsentRecordDto['purpose'],
    granted: r.granted,
    source: r.source as ConsentRecordDto['source'],
    policyVersion: r.policyVersion,
    actorUserId: r.actorUserId,
    impersonated: r.impersonatedBy !== null,
    recordedAt: r.recordedAt.toISOString(),
  }));
}

// ---- retention ----

const DAY_MS = 24 * 3_600_000;

function retentionDto(row: repo.RetentionRow | null, now: Date): RetentionSettingsDto {
  if (!row) return { inactiveContactMonths: null, effectiveAt: now.toISOString(), previousMonths: null };
  const pending = row.effectiveAt.getTime() > now.getTime();
  return {
    inactiveContactMonths: row.months,
    effectiveAt: row.effectiveAt.toISOString(),
    previousMonths: pending ? row.previousMonths : null,
  };
}

/** The period in force at `now` (null = never). */
const inForce = (row: repo.RetentionRow | null, now: Date) =>
  !row ? null : row.effectiveAt.getTime() <= now.getTime() ? row.months : row.previousMonths;

/** Whether `next` keeps contacts for less time than `current` (null = never: forever). */
const shorter = (next: number | null, current: number | null) => next !== null && (current === null || next < current);

/** `GET /v1/agency/retention` (admins). */
export async function getRetentionSettings(ctx: Ctx): Promise<RetentionSettingsDto> {
  assertCan(ctx, 'compliance.retention.read');
  return retentionDto(await repo.getRetention(ctx.tx, ctx.tenant.agencyId), clock.now());
}

/**
 * `PUT /v1/agency/retention` (admins, never impersonating staff), with a fresh second factor (`verifyStepUp`, bound by
 * `updateRetentionSettings` at the core root — compliance cannot import identity). A period shorter than the one in
 * force (or one newly turned on) applies only `RETENTION_GRACE_DAYS` later — until then the one in force stays — so
 * a mistake can be undone before anyone is erased; a longer period or "never" applies at once. Audited (from, to, when).
 */
export async function setRetentionSettings(
  ctx: Ctx,
  input: { inactiveContactMonths: number | null },
  opts: { verifyStepUp: () => Promise<void> },
): Promise<RetentionSettingsDto> {
  assertCan(ctx, 'compliance.retention.manage');
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  await opts.verifyStepUp();
  const now = clock.now();
  const months = input.inactiveContactMonths;
  const before = await repo.lockRetention(ctx.tx, ctx.tenant.agencyId);
  const current = inForce(before, now);
  const next: repo.RetentionRow = shorter(months, current)
    ? { months, previousMonths: current, effectiveAt: new Date(now.getTime() + RETENTION_GRACE_DAYS * DAY_MS) }
    : { months, previousMonths: null, effectiveAt: now };
  await repo.upsertRetention(ctx.tx, ctx.tenant.agencyId, { ...next, updatedBy: ctx.actor.userId });
  if (before?.months !== months || current !== months) {
    await audit(
      ctx,
      'compliance.retention.changed',
      { type: 'agency', id: ctx.tenant.agencyId },
      { from: current, to: months, effectiveAt: next.effectiveAt.toISOString() },
    );
  }
  return retentionDto(next, now);
}

/**
 * S16 review: the agency's period in force at `now` (null = never: nobody is erased), read afresh — the retention job
 * checks it before erasing anyone (its payload's period may be stale: lengthened or turned off since it was queued).
 */
export async function retentionMonthsInForce(
  tx: Tx,
  agencyId: string,
  now: Date = clock.now(),
): Promise<number | null> {
  return inForce(await repo.getRetention(tx, agencyId), now);
}

/** Agencies with a period in force, a page at a time in id order (the daily job; worker `tx` as `app_system`). */
export const retentionAgenciesPage = (tx: Tx, after: string | null, limit: number, now: Date = clock.now()) =>
  repo.retentionPage(tx, now, after, limit);

// ---- data export files of erased people ----

/**
 * After an erasure (workers only, outside any transaction): the data export files that may hold the erased people —
 * for a contact erasure the `SUBJECT` exports of these contacts and every export of the agency that lists contacts
 * (`CONTACTS`, `LEADS`, `ACCOUNT`: S16-04 review), for an agency erasure (`'ALL'`) every export — expire now and their
 * files are deleted. One transaction when there is nothing to expire. Job state is worker-only (S11-F3):
 * `app_system`, the agency an explicit predicate. Idempotent: a deleted file is not listed again; one whose delete
 * failed stays expired for the daily sweep.
 */
export async function expireErasedExports(p: {
  agencyId: string;
  scope: { subjectContactIds: readonly string[] } | 'ALL';
}): Promise<{ files: number }> {
  const scope = p.scope;
  const ids = await withSystem('compliance.expireErasedExports', (tx) => repo.expireExports(tx, p.agencyId, scope));
  if (ids.length === 0) return { files: 0 };
  const deleted: string[] = [];
  for (const id of ids) {
    const ok = await storage()
      .delete('private', dataExportKey(p.agencyId, id))
      .then(() => true)
      .catch(() => false);
    if (ok) deleted.push(id);
  }
  if (deleted.length > 0) {
    await withSystem('compliance.expireErasedExports', (tx) => exportRepo.markExpired(tx, deleted));
  }
  return { files: deleted.length };
}
