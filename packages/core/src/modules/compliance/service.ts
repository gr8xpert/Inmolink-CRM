import type {
  AuditLogEntryDto,
  AuditLogPage,
  PageQuery,
  StaffAuditEntryDto,
  StaffAuditPage,
  StaffAuditQuery,
} from '@inmolink/contracts';
import { setAuthScope, type Tx } from '@inmolink/db';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { PLATFORM_AGENCY_ID } from '@inmolink/platform/outbox';
import type { Ctx, StaffCtx } from '../../context';
import { decodeCursor, toPage } from '../../pagination';
import { assertCan, assertStaffCan } from './policy';
import * as repo from './repo';

/**
 * compliance use cases (PATTERNS §7). The audit log (S1-08, PLAN §6 §12): security-relevant actions are
 * recorded by the module that performs them, in the transaction of the change — the row exists if and
 * only if the change commits, and carries the request id and both actors (user and impersonating staff).
 * Writes are one INSERT each; nothing here calls the network.
 */

/**
 * Every audit type. `<module>.<entity>.<change>`; adding one is a code change (and a STATUS note), so the
 * log stays a closed, documented vocabulary. Impersonation types are written by the staff console (S1-09).
 */
export const AUDIT_TYPES = [
  'identity.login.succeeded',
  'identity.login.failed',
  'identity.password.reset',
  'identity.twoFactor.enabled',
  'identity.twoFactor.disabled',
  'identity.twoFactor.verified',
  'identity.twoFactor.failed',
  'identity.twoFactor.recoveryCodeUsed',
  'identity.twoFactor.recoveryCodesRegenerated',
  'identity.twoFactor.devicesForgotten',
  'identity.member.invited',
  'identity.member.joined',
  'identity.member.roleChanged',
  'identity.member.deactivated',
  'identity.staff.granted',
  'identity.staff.revoked',
  'identity.apiKey.created',
  'identity.apiKey.rotated',
  'identity.apiKey.revoked',
  'identity.apiKey.tierChanged',
  'identity.apiKey.legacyQueryKeyChanged',
  // S12-06: Client Mode started (tenant ctx), ended with the PIN, a wrong or throttled PIN (never the PIN itself).
  'identity.clientMode.started',
  'identity.clientMode.ended',
  'identity.clientMode.pinFailed',
  'agencies.verification.decided',
  'agencies.profile.updated',
  'agencies.giveToGet.changed',
  'media.document.uploaded',
  'media.document.opened',
  'media.document.deleted',
  'developments.document.uploaded',
  'developments.document.opened',
  'developments.document.changed',
  'developments.document.deleted',
  'developments.development.accessChanged',
  'developments.development.commissionChanged',
  'developments.unit.commissionChanged',
  'developments.priceList.approved',
  'imports.connection.created',
  'imports.connection.changed',
  'imports.mappingProfile.created',
  'imports.mappingProfile.changed',
  'imports.sheet.started',
  'imports.connection.deleted',
  'imports.run.requested',
  'imports.connection.resumed',
  'websites.site.created',
  'websites.site.changed',
  // S12-F25: a site's minimum commission (CUSTOM, network listings) changed — metadata: old and new basis points.
  'websites.site.minCommissionChanged',
  'websites.feed.rotated',
  'websites.feed.revoked',
  'exports.connection.created',
  'exports.connection.changed',
  'exports.connection.deleted',
  'exports.connection.tokenRotated',
  'exports.connection.tokenReplayed',
  'exports.connection.tokenRevoked',
  'exports.connection.selectionChanged',
  'staff.impersonation.started',
  'staff.impersonation.ended',
  'staff.auditLog.read',
  'staff.tenant.read',
  'staff.members.read',
  'staff.taxonomy.changed',
  'staff.imports.resumed',
  'compliance.dataExport.requested',
  'compliance.dataExport.downloaded',
  // S11-01: a client registration refused because another agency registered the client first (probe budget).
  'mls.registration.conflicted',
  // S11-02: one side accepted a viewing request's terms snapshot (the introducer by requesting, the owner by accepting).
  'mls.viewing.termsAccepted',
  // S11-F2: a member's ICS feed URL (a credential) issued (none before), rotated (replacing a live one) or revoked.
  'crm.calendarFeed.issued',
  'crm.calendarFeed.rotated',
  'crm.calendarFeed.revoked',
  // S11-F2: two contacts merged (target: the survivor; metadata: the closed contact's id).
  'crm.contact.merged',
  // S11-F12: a contact's personal data erased (target: the tombstone; no metadata — nothing of the person).
  'crm.contact.erased',
  // S11-F12: the erasure's after-commit job finished (actor: system; metadata: activities, inboundLeads, listings cleared).
  'crm.contact.erasureCompleted',
  // S11-F2: a bulk contact import queued (target: the import; metadata: rows, duplicate policy).
  'crm.contactImport.started',
  // S11-F2: client data (contacts, leads, activities, calendar, prospects, tasks, pipeline) read by staff
  // impersonating a member — one row per list / get call; never written for the member's own reads.
  'crm.clientData.read',
  // S12-F9: registrations (decrypted client details), introducer-side viewing requests (list, get) and VIEWING /
  // NETWORK chat messages read by staff impersonating a member — one row per list / get call.
  'mls.clientData.read',
  'chat.clientData.read',
  // S12-F13: a network board post published / closed (target: the post; metadata: its kind — never title or body).
  'network.post.published',
  'network.post.closed',
] as const;
export type AuditType = (typeof AUDIT_TYPES)[number];

export interface AuditTarget {
  type:
    | 'user'
    | 'apiKey'
    | 'agency'
    | 'verificationRequest'
    | 'invite'
    | 'taxonomy'
    | 'listingDocument'
    | 'development'
    | 'unit'
    | 'priceList'
    | 'developmentDocument'
    | 'feedConnection'
    | 'feedMappingProfile'
    | 'site'
    | 'portalConnection'
    | 'dataExport'
    | 'viewingRequest'
    | 'calendarFeed'
    | 'calendarEvent'
    | 'contact'
    | 'contactImport'
    | 'lead'
    | 'prospect'
    | 'task'
    | 'networkPost';
  id: string;
}

/** Ids, field names, enum values and counts — never passwords, tokens, key secrets, emails or free text. */
export type AuditMetadata = Record<string, string | number | boolean | null | readonly string[]>;

/** Mirrors `audit_logs_metadata_ck`: a bigger payload is a programming error, caught before the INSERT. */
export const MAX_AUDIT_METADATA_BYTES = 4096;
const MAX_REQUEST_ID = 128;

function checkedMetadata(type: AuditType, metadata: AuditMetadata): Record<string, unknown> {
  const bytes = Buffer.byteLength(JSON.stringify(metadata));
  if (bytes > MAX_AUDIT_METADATA_BYTES) {
    throw new TypeError(`audit ${type}: metadata is ${bytes} bytes (max ${MAX_AUDIT_METADATA_BYTES}); record ids only`);
  }
  return metadata;
}

function entry(
  type: AuditType,
  agencyId: string,
  actor: Pick<repo.AuditLogInsert, 'actorKind' | 'actorUserId' | 'impersonatedBy'>,
  target: AuditTarget | null,
  requestId: string | undefined,
  metadata: AuditMetadata,
): repo.AuditLogInsert {
  return {
    id: newId(),
    agencyId,
    type,
    ...actor,
    targetType: target?.type ?? null,
    targetId: target?.id ?? null,
    requestId: requestId ? requestId.slice(0, MAX_REQUEST_ID) : null,
    metadata: checkedMetadata(type, metadata),
  };
}

/**
 * Records an action of a tenant request (`withTenant`, app_user) for `ctx.tenant`'s audit log, with the
 * acting user and the staff member impersonating them, if any. Call it in the transaction of the change.
 */
export async function audit(
  ctx: Ctx,
  type: AuditType,
  target: AuditTarget | null,
  metadata: AuditMetadata = {},
): Promise<void> {
  const { actor } = ctx;
  const who =
    actor.kind === 'user'
      ? { actorKind: 'user' as const, actorUserId: actor.userId, impersonatedBy: actor.impersonatedBy ?? null }
      : { actorKind: actor.kind, actorUserId: null, impersonatedBy: null };
  await repo.insertAuditLog(ctx.tx, entry(type, ctx.tenant.agencyId, who, target, ctx.requestId, metadata));
}

/**
 * Records a staff action (`withStaff`, app_staff) under the agency it concerns, or the platform (nil
 * agency) when it concerns none. RLS lets staff append only rows naming themselves as the actor.
 */
export async function auditStaff(
  ctx: StaffCtx,
  agencyId: string | null,
  type: AuditType,
  target: AuditTarget | null,
  metadata: AuditMetadata = {},
): Promise<void> {
  const who = { actorKind: 'staff' as const, actorUserId: ctx.actor.userId, impersonatedBy: null };
  await repo.insertAuditLog(ctx.tx, entry(type, agencyId ?? PLATFORM_AGENCY_ID, who, target, ctx.requestId, metadata));
}

export interface AuthAuditInput {
  type: Extract<AuditType, `identity.${string}`>;
  /** The account the flow is about (login, 2FA). */
  userId: string;
  /** The user's agency; null for staff and users without a membership (platform row). */
  agencyId: string | null;
  /** True when the user is authenticated (login succeeded, 2FA changed); false for a failed login. */
  authenticated: boolean;
  requestId: string;
  metadata?: AuditMetadata;
}

/**
 * Records an anonymous auth-flow event (`withAuth`, app_auth): login, 2FA, invite acceptance, password
 * reset. RLS lets app_auth append only `identity.*` rows about the user and agency it is scoped to, and
 * checks the agency is that user's membership (the nil agency without one) — `agencyId` is not trusted.
 * The scope is set for the INSERT and restored afterwards, so the caller's later statements run under
 * the scope they had.
 */
export async function auditAuth(tx: Tx, input: AuthAuditInput): Promise<void> {
  const agencyId = input.agencyId ?? PLATFORM_AGENCY_ID;
  const prev = await repo.currentScope(tx);
  await setAuthScope(tx, { agencyId, userId: input.userId });
  const who = input.authenticated
    ? { actorKind: 'user' as const, actorUserId: input.userId, impersonatedBy: null }
    : { actorKind: 'anonymous' as const, actorUserId: null, impersonatedBy: null };
  await repo.insertAuditLog(
    tx,
    entry(input.type, agencyId, who, { type: 'user', id: input.userId }, input.requestId, input.metadata ?? {}),
  );
  await setAuthScope(tx, prev);
}

/**
 * Records an action of an operator script or job (`withSystem`, app_system) — staff grants (`pnpm
 * staff:grant`). Who asked and why stays in the `withSystem` log line; the row says that a reason was
 * given, never its text.
 */
export async function auditSystem(
  tx: Tx,
  input: {
    type: AuditType;
    agencyId: string | null;
    target: AuditTarget | null;
    requestId?: string;
    metadata?: AuditMetadata;
  },
): Promise<void> {
  const who = { actorKind: 'system' as const, actorUserId: null, impersonatedBy: null };
  await repo.insertAuditLog(
    tx,
    entry(input.type, input.agencyId ?? PLATFORM_AGENCY_ID, who, input.target, input.requestId, input.metadata ?? {}),
  );
}

function toDto(row: repo.AuditLogRow): AuditLogEntryDto {
  const staff = row.actorKind === 'staff';
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    type: row.type,
    actor: {
      kind: row.actorKind as AuditLogEntryDto['actor']['kind'],
      // Staff identities stay with Inmolink: tenants see that staff acted, not who.
      userId: staff ? null : row.actorUserId,
      impersonated: row.impersonatedBy !== null,
    },
    target: row.targetType && row.targetId ? { type: row.targetType, id: row.targetId } : null,
    requestId: row.requestId,
    metadata: row.metadata,
  };
}

/** `GET /v1/agency/audit-log`: the agency's admins (not in Client Mode); newest first, keyset pages. */
export async function listAuditLog(ctx: Ctx, q: PageQuery): Promise<AuditLogPage> {
  assertCan(ctx, 'compliance.auditLog.read');
  const rows = await repo.listAuditLogs(ctx.tx, ctx.tenant.agencyId, {
    limit: q.limit,
    cursor: decodeCursor(q.cursor),
  });
  return toPage(rows, q.limit, (r) => ({ at: r.occurredAt, id: r.id }), toDto);
}

function toStaffDto(row: repo.StaffAuditRow): StaffAuditEntryDto {
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    agencyId: row.agencyId,
    // Names are added by `listStaffAuditLog` (core): compliance cannot read other modules' tables.
    agencyName: null,
    type: row.type,
    actor: {
      kind: row.actorKind as StaffAuditEntryDto['actor']['kind'],
      userId: row.actorUserId,
      userName: null,
      impersonatedBy: row.impersonatedBy,
      impersonatedByName: null,
    },
    target: row.targetType && row.targetId ? { type: row.targetType, id: row.targetId, name: null } : null,
    requestId: row.requestId,
    metadata: row.metadata,
  };
}

/**
 * `GET /v1/staff/audit-logs` (S1-09): every agency's log, or one agency's, newest first, keyset ≤ 100,
 * with both actors. Reading is itself audited (`staff.auditLog.read`, PLAN §12 "all staff actions
 * audited"): under the agency read, or the platform row for a cross-agency read — in the same transaction,
 * so a read that fails leaves no row and a row means the page was served.
 */
export async function listAuditLogForStaff(ctx: StaffCtx, q: StaffAuditQuery): Promise<StaffAuditPage> {
  assertStaffCan(ctx, 'staff.auditLog.read');
  const from = q.from ? new Date(q.from) : undefined;
  const to = q.to ? new Date(q.to) : undefined;
  if (from && to && from >= to) throw new AppError('VALIDATION_FAILED', { field: 'to' });
  const rows = await repo.listAuditLogsForStaff(ctx.tx, {
    agencyId: q.agencyId,
    type: q.type,
    from,
    to,
    limit: q.limit,
    cursor: decodeCursor(q.cursor),
  });
  await auditStaff(
    ctx,
    q.agencyId ?? null,
    'staff.auditLog.read',
    q.agencyId ? { type: 'agency', id: q.agencyId } : null,
    { type: q.type ?? null, from: q.from ?? null, to: q.to ?? null, nextPage: q.cursor !== undefined },
  );
  return toPage(rows, q.limit, (r) => ({ at: r.occurredAt, id: r.id }), toStaffDto);
}
