/**
 * Legacy members (S14-02, ADR 0006): the users of a legacy agency become members of its v2 agency. Legacy password
 * hashes are never imported: every migrated member gets an unusable password and signs in through the password-reset
 * flow (`requestLegacyPasswordResets`, sent at cutover). A user is matched by its e-mail: already a member of the
 * agency → kept as is (v2 is authoritative); a member of another agency, or an account without one (staff) → not
 * migrated and reported. Idempotent: a re-run finds every member it created.
 *
 * The caller is the operator's load script in a `withSystem()` transaction: there is no member acting, so no policy
 * check and no seat check (the legacy agency's team moves as it is); one audit entry per batch records the change.
 */
import type { MemberRole } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { newToken } from '@inmolink/platform/crypto';
import { hashPassword } from '@inmolink/platform/crypto/password';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { PLATFORM_AGENCY_ID } from '@inmolink/platform/tenancy';
import * as compliance from '../compliance';
import { identityEvents } from './events';
import * as repo from './legacy-repo';

export interface LegacyMemberInput {
  legacyId: string;
  /** Trimmed and lower-cased. */
  email: string;
  name: string;
  locale: string;
  role: MemberRole;
}

export interface LegacyMembersResult {
  /** Legacy user id → the v2 user and what the run did. */
  members: Map<string, { userId: string; outcome: 'created' | 'unchanged' }>;
  skipped: { legacyId: string; reason: 'email_taken'; detail: string }[];
}

/**
 * The unusable password of migrated members: the hash of a random secret that is thrown away. Compute it once per run,
 * before any transaction (Argon2id costs tens of ms of CPU).
 */
export async function legacyPasswordPlaceholder(): Promise<string> {
  return hashPassword(newToken(32));
}

/** Imports one batch of a legacy agency's users (fixed statements: lookup, users, members, events, audit). */
export async function importLegacyMembers(
  tx: Tx,
  agencyId: string,
  inputs: readonly LegacyMemberInput[],
  passwordHash: string,
): Promise<LegacyMembersResult> {
  const out: LegacyMembersResult = { members: new Map(), skipped: [] };
  const byEmail = new Map<string, LegacyMemberInput>();
  for (const i of inputs) if (!byEmail.has(i.email)) byEmail.set(i.email, i);
  const found = new Map((await repo.usersByEmail(tx, [...byEmail.keys()])).map((u) => [u.email, u]));
  const fresh: repo.LegacyUserInsert[] = [];
  for (const input of inputs) {
    const first = byEmail.get(input.email);
    const user = found.get(input.email);
    if (user) {
      if (user.agencyId === agencyId) out.members.set(input.legacyId, { userId: user.id, outcome: 'unchanged' });
      else {
        out.skipped.push({
          legacyId: input.legacyId,
          reason: 'email_taken',
          detail: user.agencyId ? 'member of another agency' : 'account without an agency',
        });
      }
      continue;
    }
    if (first !== input) {
      // Two legacy users with one e-mail: the first becomes the member, the others point at it.
      const twin = out.members.get(first?.legacyId ?? '');
      if (twin) out.members.set(input.legacyId, { userId: twin.userId, outcome: 'unchanged' });
      continue;
    }
    const id = newId();
    fresh.push({ id, email: input.email, name: input.name, locale: input.locale, role: input.role });
    out.members.set(input.legacyId, { userId: id, outcome: 'created' });
  }
  if (fresh.length === 0) return out;
  await repo.insertLegacyMembers(tx, agencyId, fresh, passwordHash);
  // S13-F25: new agents' names — the white-label backfill re-checks the agency's shared texts.
  await emit(
    tx,
    fresh.map((u) => identityEvents.memberNamed({ memberAgencyId: agencyId, userId: u.id, change: 'JOINED' })),
    { agencyId: PLATFORM_AGENCY_ID },
  );
  await compliance.auditSystem(tx, {
    type: 'identity.member.migrated',
    agencyId,
    target: { type: 'agency', id: agencyId },
    metadata: { members: fresh.length },
  });
  return out;
}

/**
 * Sends the password-reset e-mail (the migrated member's way in) to these users that are active members of the
 * agency; the others are ignored. One statement plus the events. Answers how many were asked.
 */
export async function requestLegacyPasswordResets(
  tx: Tx,
  agencyId: string,
  userIds: readonly string[],
): Promise<number> {
  const ids = await repo.activeMembersAmong(tx, agencyId, [...new Set(userIds)]);
  await emit(
    tx,
    ids.map((userId) => identityEvents.passwordResetRequested({ userId })),
    { agencyId: PLATFORM_AGENCY_ID },
  );
  return ids.length;
}

/** Active members of the agency: the legacy load compares them with the plan's seats (a report warning). */
export function activeMemberCount(tx: Tx, agencyId: string): Promise<number> {
  return repo.countActiveMembers(tx, agencyId);
}
